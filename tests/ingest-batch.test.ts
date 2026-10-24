import { createRefreshHandler } from '../lib/integrations/scheduled-refresh';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BatchConfigurationError, requireBatchPoolCapacity, runRefreshBatch, type BatchDependencies } from '../worker/batch';
import { LostLeaseError, type FeedLease, type JobLease } from '../lib/jobs/types';
import { GET, runtime, maxDuration } from '../app/api/internal/refresh/route';

const job: JobLease = { id: 1, ownerId: 2, workerId: 'batch-fixture:0', fence: 3, force: false, faviconOnly: false };
const feed = { job, feed: { id: 4 }, fence: 5 } as FeedLease;
function fixture() {
  const events: string[] = [];
  const emitter = new EventEmitter();
  let acquired = true;
  let jobAvailable = true;
  let feedAvailable = true;
  const deps: BatchDependencies = {
    connect: async () => {
      events.push('connect');
      return {
        query: async (sql: string) => { events.push(sql.includes('pg_try_') ? 'lock' : 'unlock'); return { rows: [{ locked: acquired }] }; },
        release: () => { events.push('connection.release'); },
        on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter),
      } as unknown as Awaited<ReturnType<BatchDependencies['connect']>>;
    },
    context: async () => { events.push('context'); return { ownerId: 2, installationId: 1 }; },
    concurrency: () => 1, workerId: () => 'batch-fixture',
    enqueue: async () => { events.push('enqueue'); },
    heartbeat: async () => { events.push('heartbeat'); },
    stopHeartbeat: async () => { events.push('heartbeat.stop'); },
    claimJob: async () => { events.push('job.claim'); if (!jobAvailable) return null; jobAvailable = false; return job; },
    claimFeed: async () => { events.push('feed.claim'); if (!feedAvailable) return null; feedAvailable = false; return feed; },
    refresh: async () => { events.push('refresh'); },
    renew: async () => { events.push('renew'); },
    releaseJob: async () => { events.push('job.release'); },
    releaseWorker: async workerId => { events.push(`leases.release:${workerId}`); },
  };
  return { deps, events, emitter, refuseLock: () => { acquired = false; } };
}

test('the actual route exports a finite Node handler and rejects anonymous invocation', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'fixture-secret';
  try {
    assert.equal(runtime, 'nodejs');
    assert.equal(maxDuration, 300);
    assert.equal((await GET(new Request('https://example.com/api/internal/refresh'))).status, 401);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('cron authentication fails closed before any work and uses an exact bearer token', async () => {
  let calls = 0;
  const run = async () => { calls++; return { status: 'drained' as const, jobs: 0, feeds: 0 }; };
  const request = (authorization?: string) => new Request('https://example.com/api/internal/refresh', { headers: authorization ? { authorization } : {} });
  assert.equal((await createRefreshHandler(run, () => undefined)(request())).status, 503);
  const handler = createRefreshHandler(run, () => 'fixture-secret');
  for (const authorization of [undefined, 'fixture-secret', 'Bearer wrong', 'Bearer fixture-secrex', 'bearer fixture-secret']) assert.equal((await handler(request(authorization))).status, 401);
  assert.equal(calls, 0);
  const response = await handler(request('Bearer fixture-secret'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'drained', jobs: 0, feeds: 0 });
  assert.equal(calls, 1);
});

test('cron failures return redacted errors', async () => {
  const handler = createRefreshHandler(async () => { throw new Error('postgresql://secret@example.com/private'); }, () => 'fixture');
  const response = await handler(new Request('https://example.com', { headers: { authorization: 'Bearer fixture' } }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Scheduled refresh failed.' });
});

test('session locking requires a second pool connection and exposes a safe actionable configuration error', async () => {
  for (const capacity of [0, 1, 1.5]) assert.throws(() => requireBatchPoolCapacity(capacity), BatchConfigurationError);
  for (const capacity of [2, 3, 10]) assert.doesNotThrow(() => requireBatchPoolCapacity(capacity));
  const handler = createRefreshHandler(async () => { requireBatchPoolCapacity(1); throw new Error('unreachable'); }, () => 'fixture');
  const response = await handler(new Request('https://example.com', { headers: { authorization: 'Bearer fixture' } }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Scheduled refresh requires a database pool of at least two connections.' });
});

test('finite drain reuses job/refresh lifecycle and releases leases, heartbeat, and session lock', async () => {
  const { deps, events, emitter } = fixture();
  assert.deepEqual(await runRefreshBatch({}, deps), { status: 'drained', jobs: 1, feeds: 1 });
  assert.deepEqual(events, ['connect', 'lock', 'context', 'heartbeat', 'enqueue', 'job.claim', 'feed.claim', 'refresh', 'renew', 'feed.claim', 'job.release', 'job.claim', 'leases.release:batch-fixture:0', 'heartbeat.stop', 'unlock', 'connection.release']);
  assert.equal(emitter.listenerCount('error'), 0);
});

test('a concurrent invocation denied the lock performs no scheduling or lease work', async () => {
  const { deps, events, refuseLock } = fixture();
  refuseLock();
  assert.deepEqual(await runRefreshBatch({}, deps), { status: 'locked', jobs: 0, feeds: 0 });
  assert.deepEqual(events, ['connect', 'lock', 'connection.release']);
});

test('budget expiry aborts in-flight work and awaits its cleanup before returning', async () => {
  const { deps, events } = fixture();
  deps.refresh = async (_feed, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => {
      setTimeout(() => { events.push('refresh.cleaned'); resolve(); }, 10);
    }, { once: true }));
    throw new LostLeaseError();
  };
  assert.deepEqual(await runRefreshBatch({ budgetMs: 20 }, deps), { status: 'budget_exhausted', jobs: 1, feeds: 0 });
  assert.ok(events.indexOf('refresh.cleaned') < events.indexOf('leases.release:batch-fixture:0'));
  assert.equal(events.at(-1), 'connection.release');
  assert.ok(!events.includes('renew'));
});

test('caller cancellation before starting causes no database activity', async () => {
  const { deps, events } = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await runRefreshBatch({ signal: controller.signal }, deps), { status: 'cancelled', jobs: 0, feeds: 0 });
  assert.deepEqual(events, []);
});

test('a worker failure aborts peer lanes and still releases every lane and heartbeat', async () => {
  const { deps, events } = fixture();
  deps.concurrency = () => 2;
  deps.claimJob = async (_context, id) => ({ ...job, workerId: id });
  deps.claimFeed = async lease => ({ ...feed, job: lease });
  deps.refresh = async (lease, signal) => {
    if (lease.job.workerId.endsWith(':0')) throw new Error('fixture failure');
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    events.push('peer.finished');
    throw new LostLeaseError();
  };
  await assert.rejects(runRefreshBatch({}, deps), /fixture failure/);
  assert.ok(events.includes('peer.finished'));
  assert.ok(events.includes('leases.release:batch-fixture:0'));
  assert.ok(events.includes('leases.release:batch-fixture:1'));
  assert.ok(events.includes('heartbeat.stop'));
  assert.deepEqual(events.slice(-2), ['unlock', 'connection.release']);
});

test('cleanup failures still release the advisory lock and checked-out connection', async () => {
  const { deps, events } = fixture();
  deps.releaseWorker = async () => { events.push('leases.failed'); throw new Error('cleanup failure'); };
  await assert.rejects(runRefreshBatch({}, deps), /cleanup failure/);
  assert.ok(events.includes('heartbeat.stop'));
  assert.deepEqual(events.slice(-2), ['unlock', 'connection.release']);
});

test('session connection loss aborts work and is reported after cleanup', async () => {
  const { deps, events, emitter } = fixture();
  deps.refresh = async (_feed, signal) => {
    emitter.emit('error', new Error('lock connection lost'));
    assert.equal(signal.aborted, true);
    throw new LostLeaseError();
  };
  await assert.rejects(runRefreshBatch({}, deps), /lock connection lost/);
  assert.deepEqual(events.slice(-2), ['unlock', 'connection.release']);
});

test('invalid budgets reject before acquiring a database connection', async () => {
  const { deps, events } = fixture();
  for (const budgetMs of [0, -1, 240_001, 1.5]) await assert.rejects(runRefreshBatch({ budgetMs }, deps), RangeError);
  assert.deepEqual(events, []);
});


test('finite batch retains completed feed counts when cancellation interrupts a later feed', async () => {
  const { deps } = fixture();
  const controller = new AbortController();
  let refreshed = 0;
  deps.claimFeed = async () => feed;
  deps.refresh = async () => {
    if (++refreshed === 2) { controller.abort(); throw new LostLeaseError(); }
  };
  const result = await runRefreshBatch({ signal: controller.signal }, deps);
  assert.deepEqual(result, { status: 'cancelled', jobs: 1, feeds: 1 });
});

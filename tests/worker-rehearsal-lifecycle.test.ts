import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import http, { type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { closeDatabase, getPool } from '../lib/db/client';
import { assertSchema, assertTarget, closeTarget, connectTarget } from '../lib/migration/target';
import { createFeed, deleteFeed, updateFeed } from '../lib/domain/subscriptions';
import { cancelRefresh, enqueueInstallationRefresh } from '../lib/jobs';
import { claimFeed, claimJob, releaseJob, releaseWorkerLeases } from '../lib/jobs/worker';
import { closeHostCoordinator } from '../lib/ingest/host-limits';
import { LostLeaseError, type FeedLease } from '../lib/jobs/types';
import { commitRefresh } from '../lib/ingest/persist';
import { parseFeed } from '../lib/ingest/parser';

const endpoint = 'ep-green-cake-arly1cyb.c-4.us-west-2.aws.neon.tech';
const fingerprint = 'c5ed350ed2e35b58e8f833c20c4b93b57a139533e145d351900121e147ea5945';
const node24 = process.execPath;
const privateDir = '/tmp/feedafever-worker-rehearsal-20261024';
const evidenceDir = resolve(process.env.FEVER_TEST_EVIDENCE_DIR ?? 'tests/.artifacts/worker');
const enabled = process.env.FEVER_WORKER_REHEARSAL === '1';

test('isolated PostgreSQL worker crash, fencing, cancellation, retention and shutdown rehearsal', { skip: !enabled, timeout: 720_000 }, async t => {
  assert.equal(process.versions.node.split('.')[0], '24');
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, endpoint, 'Refusing a different PostgreSQL branch');
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const pool = getPool();
  const operator = await connectTarget(process.env.DATABASE_URL!);
  const owner = { id: 1, email: `worker-${randomUUID()}@example.test` };
  const context = { ownerId: 1, installationId: 1 as const };
  const children = new Set<ChildProcess>();
  const lastChildActions = new Map<number, { event: string; time?: string; code?: string }>();
  const observations: Record<string, unknown> = { startedAt: new Date().toISOString(), endpoint, fingerprint, node: process.version };
  const selectedCase = process.env.FEVER_WORKER_REHEARSAL_CASE;
  const stopOwnedChildren = async (owned: ChildProcess[]) => {
    await Promise.all(owned.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      let timer: NodeJS.Timeout | undefined;
      let forced = false;
      child.kill('SIGTERM');
      try {
        timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 15_000);
        await exited;
        if (forced) throw new Error('Scenario worker required SIGKILL after 15 seconds');
      } finally { clearTimeout(timer); }
    }));
  };
  const scenario = (name: string, run: () => Promise<void>) => t.test(name, { skip: Boolean(selectedCase && !name.includes(selectedCase)) }, async subtest => {
    const earlierChildren = new Set(children);
    let failed = false;
    try { await run(); }
    catch (error) { failed = true; throw error; }
    finally {
      try { await stopOwnedChildren([...children].filter(child => !earlierChildren.has(child))); await resetQueues(); }
      catch (error) { if (failed) subtest.diagnostic(`Scenario cleanup failed: ${(error as Error).message}`); else throw error; }
    }
  });
  const held = new Map<string, ServerResponse[]>();
  const blocking = new Set<string>();
  const transientOnce = new Set<string>();
  const titles = new Map<string, string>();
  let requests = 0;
  const rss = (path: string, title = 'Fixture article', old = false) => `<rss><channel><title>Fixture</title><link>http://127.0.0.1/</link><item><guid isPermaLink="false">${path}</guid><title>${title}</title><link>https://example.test/article/${path}</link><pubDate>${new Date(Date.now() - (old ? 100 : 1) * 86_400_000).toUTCString()}</pubDate><description><![CDATA[<p>Fixture content <a href="https://example.test/citation">citation</a></p>]]></description></item></channel></rss>`;
  const server = http.createServer((request, response) => {
    requests++;
    const path = request.url!;
    response.setHeader('content-type', 'application/rss+xml');
    if (transientOnce.delete(path)) { response.statusCode = 503; response.setHeader('retry-after', '0'); response.end('Temporary fixture failure'); }
    else if (blocking.has(path)) {
      const list = held.get(path) ?? []; list.push(response); held.set(path, list);
      // Keep the real transport's read-idle timeout satisfied while the test
      // deliberately holds the document open to observe lease renewal.
      response.write(' ');
      const keepalive = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(' '); }, 2000);
      response.once('close', () => clearInterval(keepalive));
    }
    else response.end(rss(path, titles.get(path)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.FEVER_ALLOWED_PRIVATE_ORIGINS = origin;
  const sql = (query: string, values?: unknown[]) => pool.query(query, values);
  const until = async <T,>(label: string, check: () => Promise<T | null | false | undefined>, timeout = 40_000, diagnostic?: () => Promise<unknown>): Promise<T> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100); }
    throw new Error(`Timed out waiting for ${label}${diagnostic ? `: ${JSON.stringify(await diagnostic())}` : ''}`);
  };
  const arriving = (path: string, count = 1) => until(`controlled request ${path}`, async () => (held.get(path)?.length ?? 0) >= count ? held.get(path)! : null);
  const respond = (path: string, index = 0, title = 'Fixture article', old = false) => {
    const response = held.get(path)?.[index]; assert.ok(response, 'The expected controlled HTTP request must exist'); response.end(rss(path, title, old));
  };
  const start = (label: string, mode = 'worker', args: string[] = [], extra: Record<string, string | undefined> = {}) => {
    const child = spawn(node24, ['--network-family-autoselection-attempt-timeout=1000', '--conditions=react-server', '--import', 'tsx', 'tests/worker-rehearsal-child.ts', mode, ...args], {
      env: { ...process.env, FEVER_WORKER_CONCURRENCY: '1', ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let output = '';
    const capture = (data: Buffer) => {
      output += data;
      for (const line of output.trimEnd().split('\n').reverse()) {
        try {
          const event = JSON.parse(line) as { event?: unknown; time?: unknown; code?: unknown };
          if (typeof event.event === 'string' && child.pid) {
            lastChildActions.set(child.pid, { event: event.event, ...(typeof event.time === 'string' ? { time: event.time } : {}), ...(typeof event.code === 'string' ? { code: event.code } : {}) });
            break;
          }
        } catch { /* Partial lines are completed by the next stream chunk. */ }
      }
    };
    child.stdout!.on('data', capture);
    child.stderr!.on('data', capture);
    const done = once(child, 'exit').then(async ([code, signal]) => {
      children.delete(child);
      await writeFile(`${evidenceDir}/${label}.log`, output);
      return { code, signal, output };
    });
    return { child, done };
  };
  const stop = async (process: ReturnType<typeof start>) => {
    if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGTERM');
    const result = await Promise.race([process.done, delay(15_000).then(() => { throw new Error('Worker did not shut down gracefully'); })]);
    assert.equal(result.code, 0, result.output); assert.equal(result.signal, null);
    return result;
  };
  const makeFeed = async (path: string) => {
    const feed = await createFeed(owner, { url: `${origin}${path}`, title: path });
    await sql('UPDATE feeds SET favicon_id=2 WHERE id=$1', [feed.id]);
    return feed;
  };
  const enqueue = (id: number) => enqueueInstallationRefresh(context, { scope: 'feed', id, force: true });
  const lease = async (id: number, workerId: string) => {
    await enqueue(id);
    const job = await claimJob(context, workerId); assert.ok(job);
    const feed = await claimFeed(job); assert.ok(feed); assert.equal(feed.feed.id, id);
    return feed;
  };
  const startRefresh = async (label: string, feed: FeedLease, extra: Record<string, string | undefined> = {}) => {
    const path = `${privateDir}/${label}-${randomUUID()}.json`;
    await writeFile(path, JSON.stringify(feed), { mode: 0o600 });
    return start(label, 'refresh', [path], extra);
  };
  const completed = async (id: number) => until(`job ${id} completion`, async () => {
    const row = (await sql('SELECT * FROM refresh_jobs WHERE id=$1', [id])).rows[0];
    if (row.status === 'failed') throw new Error(`Fixture refresh failed: ${row.error}`);
    return row.status === 'completed' ? row : null;
  }, 90_000, async () => ({
    job: (await sql('SELECT id,status,error,lease_owner,lease_expires_at,fence,current_feed_id FROM refresh_jobs WHERE id=$1', [id])).rows[0],
    results: (await sql('SELECT feed_id,status,attempts,fence FROM job_feed_results WHERE job_id=$1 ORDER BY feed_id', [id])).rows,
    workers: [...lastChildActions].map(([pid, action]) => ({ pid, ...action })),
  }));
  const resetQueues = async () => {
    await sql("UPDATE refresh_jobs SET status='cancelled',finished_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,fence=fence+1 WHERE status IN ('queued','running')");
    await sql('UPDATE feed_fetch_state SET lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=floor(extract(epoch FROM clock_timestamp()))+86400,fence=fence+1');
  };
  let ownsOwner = false;
  try {
    await assertTarget(operator, process.env.DATABASE_URL!, fingerprint);
    await assertSchema(operator);
    assert.equal((await sql('SELECT count(*)::int AS n FROM owner')).rows[0].n, 0, 'Refusing an existing installation');
    assert.equal((await sql('SELECT status FROM installation WHERE id=1')).rows[0].status, 'uninitialized');
    await sql("INSERT INTO owner(id,email,email_key,password_hash) VALUES(1,$1,$2,'worker-fixture-only')", [owner.email, owner.email]);
    ownsOwner = true;
    await sql('INSERT INTO reader_preferences(owner_id) VALUES(1)');
    await sql("INSERT INTO favicons(id,owner_id,url,url_key,content_hash,data) VALUES(2,1,'fixture-icon','fixture-icon','fixture-icon',$1)", [Buffer.from([1])]);
    await sql("UPDATE installation SET status='ready' WHERE id=1");

    await scenario('SIGKILL before merge, expired leases, restart, and replay preserve exactly one item and reading state', async () => {
      const path = `/kill-${randomUUID()}`; blocking.add(path);
      const feed = await makeFeed(path);
      const job = await enqueue(feed.id);
      const first = start('kill-before-merge');
      await arriving(path);
      const before = (await sql('SELECT fence FROM feed_fetch_state WHERE feed_id=$1', [feed.id])).rows[0];
      first.child.kill('SIGKILL');
      assert.equal((await first.done).signal, 'SIGKILL');
      assert.equal((await sql('SELECT count(*)::int AS n FROM items WHERE feed_id=$1', [feed.id])).rows[0].n, 0);
      blocking.delete(path);
      await sql("UPDATE refresh_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
      await sql("UPDATE feed_fetch_state SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE feed_id=$1", [feed.id]);
      const restarted = start('restart-after-expiry');
      await completed(job.id);
      const item = (await sql('SELECT id,added_at,published_at FROM items WHERE feed_id=$1', [feed.id])).rows[0];
      const after = (await sql('SELECT fence FROM feed_fetch_state WHERE feed_id=$1', [feed.id])).rows[0];
      assert.ok(BigInt(after.fence) > BigInt(before.fence));
      await sql('UPDATE items SET read_at=42,is_saved=true WHERE id=$1', [item.id]);
      restarted.child.kill('SIGKILL'); assert.equal((await restarted.done).signal, 'SIGKILL');
      await sql("UPDATE refresh_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE status='running'");
      await sql("UPDATE feed_fetch_state SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE lease_owner IS NOT NULL");
      titles.set(path, 'Updated publisher title');
      const replay = await enqueue(feed.id);
      const third = start('restart-after-commit');
      await completed(replay.id);
      const retained = (await sql('SELECT id,title,added_at,published_at,read_at,is_saved FROM items WHERE feed_id=$1', [feed.id])).rows;
      assert.deepEqual(retained, [{ ...item, title: 'Updated publisher title', read_at: '42', is_saved: true }]);
      const graceful = await stop(third);
      assert.match(graceful.output, /worker.stopped/);
      assert.equal((await sql("SELECT count(*)::int AS n FROM feed_fetch_state WHERE lease_owner IS NOT NULL")).rows[0].n, 0);
      observations.killRestart = { beforeFence: before.fence, afterFence: after.fence, itemCount: retained.length, updatedTitle: retained[0].title, preservedReadAt: retained[0].read_at, gracefulExit: true };
      await resetQueues();
    });

    await scenario('an expired worker response cannot commit after a replacement fence has been claimed', async () => {
      const path = `/fence-${randomUUID()}`; blocking.add(path);
      const feed = await makeFeed(path);
      const old = await lease(feed.id, 'fence-old');
      const first = await startRefresh('stale-fence', old);
      await arriving(path);
      await sql("UPDATE refresh_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old.job.id]);
      await sql("UPDATE feed_fetch_state SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE feed_id=$1", [feed.id]);
      const replacementJob = await claimJob(context, 'fence-new'); assert.ok(replacementJob);
      const replacement = await claimFeed(replacementJob); assert.ok(replacement);
      assert.ok(replacement.fence > old.fence);
      await assert.rejects(commitRefresh(old, { parsed: parseFeed(Buffer.from(rss(path, 'Stale direct merge')), `${origin}${path}`), warnings: [] }), LostLeaseError);
      const second = await startRefresh('replacement-fence', replacement);
      await arriving(path, 2);
      respond(path, 0, 'Stale title');
      assert.match((await first.done).output, /fixture.lease_lost/);
      assert.equal((await sql('SELECT count(*)::int AS n FROM items WHERE feed_id=$1', [feed.id])).rows[0].n, 0);
      respond(path, 1, 'Replacement title');
      assert.equal((await second.done).code, 0);
      await releaseJob(replacementJob);
      assert.equal((await sql('SELECT title FROM items WHERE feed_id=$1', [feed.id])).rows[0].title, 'Replacement title');
      observations.fencing = { oldFence: old.fence, replacementFence: replacement.fence, directStaleCommitRejected: true, staleItemWrites: 0 };
      await releaseWorkerLeases('fence-old'); await releaseWorkerLeases('fence-new');
      await resetQueues();
    });

    await scenario('transient HTTP failure persists retry timing and a later claimed attempt recovers without losing stored content', async () => {
      const path = `/retry-${randomUUID()}`; transientOnce.add(path);
      const feed = await makeFeed(path);
      const existing = (await sql("INSERT INTO items(feed_id,identity_key,title,published_at,added_at,read_at,is_saved) VALUES($1,$2,'Existing saved article',1,1,42,true) RETURNING id", [feed.id, randomUUID()])).rows[0].id;
      const first = await lease(feed.id, 'retry-first');
      const failed = await startRefresh('transient-first-attempt', first);
      assert.equal((await failed.done).code, 0);
      const result = (await sql('SELECT status,attempts FROM job_feed_results WHERE id=$1', [first.resultId])).rows[0];
      const state = (await sql('SELECT failure_count,next_attempt_at,last_success_at,status FROM feed_fetch_state WHERE feed_id=$1', [feed.id])).rows[0];
      assert.equal(result.status, 'retry'); assert.equal(result.attempts, 1);
      assert.equal(state.failure_count, 1); assert.equal(state.status, 'http');
      assert.ok(Number(state.next_attempt_at) > Math.floor(Date.now() / 1000));
      assert.equal(state.last_success_at, '0');
      assert.deepEqual((await sql('SELECT read_at,is_saved FROM items WHERE id=$1', [existing])).rows[0], { read_at: '42', is_saved: true });
      await releaseJob(first.job);
      // Advance the persisted fixture due clock rather than waiting for backoff.
      await sql('UPDATE feed_fetch_state SET next_attempt_at=0 WHERE feed_id=$1', [feed.id]);
      await sql('UPDATE refresh_jobs SET due_at=clock_timestamp() WHERE id=$1', [first.job.id]);
      const nextJob = await claimJob(context, 'retry-second'); assert.ok(nextJob);
      const nextFeed = await claimFeed(nextJob); assert.ok(nextFeed); assert.equal(nextFeed.attempts, 2);
      const recovered = await startRefresh('transient-second-attempt', nextFeed);
      assert.equal((await recovered.done).code, 0);
      await releaseJob(nextJob);
      assert.equal((await sql('SELECT status FROM refresh_jobs WHERE id=$1', [nextJob.id])).rows[0].status, 'completed');
      assert.equal((await sql('SELECT failure_count FROM feed_fetch_state WHERE feed_id=$1', [feed.id])).rows[0].failure_count, 0);
      assert.equal((await sql('SELECT count(*)::int AS n FROM items WHERE feed_id=$1', [feed.id])).rows[0].n, 2);
      observations.transientRetry = { firstAttempt: 'retry', nextAttempt: 2, recovered: 'completed', existingSavedStatePreserved: true };
      await releaseWorkerLeases('retry-first'); await releaseWorkerLeases('retry-second'); await resetQueues();
    });

    await scenario('cancel, changed feed URL, and unsubscribe fence in-flight responses without resurrecting content', async () => {
      for (const action of ['cancel', 'url', 'unsubscribe']) {
        const path = `/${action}-${randomUUID()}`; blocking.add(path);
        const feed = await makeFeed(path);
        const current = await lease(feed.id, `mutation-${action}`);
        const process = await startRefresh(`inflight-${action}`, current);
        await arriving(path);
        if (action === 'cancel') await cancelRefresh(owner, current.job.id);
        if (action === 'url') await updateFeed(owner, { id: feed.id, url: `${origin}/changed-${randomUUID()}` });
        if (action === 'unsubscribe') await deleteFeed(owner, { id: feed.id, confirm: true });
        respond(path, 0, 'Must never be merged');
        assert.match((await process.done).output, /fixture.lease_lost/);
        assert.equal((await sql('SELECT count(*)::int AS n FROM items WHERE feed_id=$1', [feed.id])).rows[0].n, 0);
        if (action === 'unsubscribe') assert.equal((await sql('SELECT count(*)::int AS n FROM feeds WHERE id=$1', [feed.id])).rows[0].n, 0);
        if (action === 'cancel') assert.equal((await sql('SELECT status FROM refresh_jobs WHERE id=$1', [current.job.id])).rows[0].status, 'cancelled');
        await releaseWorkerLeases(`mutation-${action}`);
        await resetQueues();
      }
      observations.mutationRaces = { cancel: 'fenced', changedUrl: 'fenced', unsubscribe: 'no resurrection' };
    });

    await scenario('SIGTERM during a network request aborts HTTP, relinquishes work, and stops heartbeat before exit', async () => {
      const path = `/sigterm-${randomUUID()}`; blocking.add(path);
      const feed = await makeFeed(path);
      const job = await enqueue(feed.id);
      const process = start('graceful-inflight-shutdown');
      await arriving(path);
      const before = (await sql('SELECT fence FROM feed_fetch_state WHERE feed_id=$1', [feed.id])).rows[0].fence;
      const stopped = await stop(process);
      assert.match(stopped.output, /worker.stopped/);
      const state = (await sql('SELECT fence,lease_owner,lease_expires_at FROM feed_fetch_state WHERE feed_id=$1', [feed.id])).rows[0];
      assert.equal(state.lease_owner, null); assert.equal(state.lease_expires_at, null);
      assert.ok(BigInt(state.fence) > BigInt(before));
      assert.equal((await sql('SELECT status FROM refresh_jobs WHERE id=$1', [job.id])).rows[0].status, 'queued');
      assert.equal((await sql('SELECT count(*)::int AS n FROM items WHERE feed_id=$1', [feed.id])).rows[0].n, 0);
      observations.gracefulInflightShutdown = { exitCode: stopped.code, fenceAdvanced: true, jobReleased: 'queued', itemWrites: 0 };
      await resetQueues();
    });

    await scenario('committed save wins a blocked retention merge; saved items survive while old links and unsaved items expire', async () => {
      const path = `/retention-${randomUUID()}`; blocking.add(path);
      const feed = await makeFeed(path);
      const oldTime = Math.floor(Date.now() / 1000) - 100 * 86_400;
      const old = (await sql('INSERT INTO items(feed_id,identity_key,title,published_at,added_at) VALUES($1,$2,\'saved-race\',$3,$3),($1,$4,\'unsaved-expired\',$3,$3) RETURNING id,title', [feed.id, randomUUID(), oldTime, randomUUID()])).rows;
      const savedId = old.find(row => row.title === 'saved-race')!.id;
      await sql("INSERT INTO link_occurrences(feed_id,item_id,url,canonical_url,url_key,url_checksum,title_url_checksum,created_at) VALUES($1,$2,'https://example.test/old','example.test/old','fixture-old',0,0,$3)", [feed.id, savedId, oldTime]);
      const current = await lease(feed.id, 'retention-worker');
      const process = await startRefresh('retention-save-race', current, { FEVER_RETENTION_ENABLED: 'true' });
      await arriving(path);
      const saver = await pool.connect();
      await saver.query('BEGIN');
      await saver.query('UPDATE items SET is_saved=true,read_at=123 WHERE id=$1', [savedId]);
      try {
        respond(path, 0, 'Too old incoming article', true);
        await until('retention merge blocked behind saved item row', async () => (await sql("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM items WHERE feed_id=%FOR UPDATE%'")).rows[0].n > 0);
      } finally { await saver.query('COMMIT'); saver.release(); }
      assert.equal((await process.done).code, 0);
      const retained = (await sql('SELECT id,title,is_saved,read_at FROM items WHERE feed_id=$1 ORDER BY id', [feed.id])).rows;
      assert.deepEqual(retained, [{ id: savedId, title: 'saved-race', is_saved: true, read_at: '123' }]);
      assert.equal((await sql('SELECT count(*)::int AS n FROM link_occurrences WHERE feed_id=$1', [feed.id])).rows[0].n, 0);
      observations.retention = { savedItemRetained: true, unsavedExpired: 1, expiredSavedItemLinks: 1, oldIncomingSkipped: true, lockWaitObserved: true };
      await releaseWorkerLeases('retention-worker'); await resetQueues();
    });

    await scenario('migration retention hold preserves old items and links', async () => {
      const path = `/hold-${randomUUID()}`;
      const feed = await makeFeed(path);
      const oldTime = Math.floor(Date.now() / 1000) - 100 * 86_400;
      const id = (await sql("INSERT INTO items(feed_id,identity_key,title,published_at,added_at) VALUES($1,$2,'hold-old',$3,$3) RETURNING id", [feed.id, randomUUID(), oldTime])).rows[0].id;
      await sql("INSERT INTO link_occurrences(feed_id,item_id,url,canonical_url,url_key,url_checksum,title_url_checksum,created_at) VALUES($1,$2,'https://example.test/hold','example.test/hold','fixture-hold',0,0,$3)", [feed.id, id, oldTime]);
      const current = await lease(feed.id, 'hold-worker');
      const process = await startRefresh('retention-hold', current, { FEVER_RETENTION_ENABLED: 'false' });
      assert.equal((await process.done).code, 0);
      assert.equal((await sql('SELECT count(*)::int AS n FROM items WHERE id=$1', [id])).rows[0].n, 1);
      assert.equal((await sql("SELECT count(*)::int AS n FROM link_occurrences WHERE item_id=$1 AND url_key='fixture-hold'", [id])).rows[0].n, 1);
      observations.retentionHold = { oldUnsavedRetained: true, oldLinkRetained: true };
      await releaseWorkerLeases('hold-worker'); await resetQueues();
    });

    await scenario('finite batch with application pool two renews leases during globally coordinated HTTP and exits cleanly', async () => {
      const path = `/pool-two-${randomUUID()}`; blocking.add(path);
      const feed = await makeFeed(path);
      const job = await enqueue(feed.id);
      const process = start('batch-pool-two', 'batch', [], { FEVER_DB_POOL_MAX: '2', FEVER_WORKER_CONCURRENCY: '2', FEVER_FETCH_TIMEOUT_MS: '60000', FEVER_DB_CONNECT_TIMEOUT_MS: '30000' });
      const initial = await until('batch feed lease acquisition', async () => {
        const row = (await sql('SELECT fence,lease_owner,lease_expires_at FROM feed_fetch_state WHERE feed_id=$1 AND lease_owner IS NOT NULL', [feed.id])).rows[0];
        return row ? { fence: row.fence, owner: row.lease_owner, expiresAt: new Date(row.lease_expires_at).getTime() } : null;
      });
      await Promise.race([arriving(path), process.done.then(result => { throw new Error(`Batch exited before HTTP: ${result.output}`); })]);
      await until('lease renewal while pool-two batch holds session lock and HTTP slot', async () => {
        const row = (await sql('SELECT fence,lease_owner,lease_expires_at FROM feed_fetch_state WHERE feed_id=$1', [feed.id])).rows[0];
        assert.equal(row.fence, initial.fence, 'A replacement claim is not a lease renewal');
        assert.equal(row.lease_owner, initial.owner, 'The same batch must retain the feed lease');
        return new Date(row.lease_expires_at).getTime() > initial.expiresAt;
      }, 35_000);
      respond(path);
      const result = await process.done;
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /fixture.batch_completed/);
      assert.match(result.output, /"status":"drained"/);
      await completed(job.id);
      assert.equal((await sql('SELECT count(*)::int AS n FROM feed_fetch_state WHERE lease_owner IS NOT NULL')).rows[0].n, 0);
      assert.equal((await sql("SELECT count(*)::int AS n FROM worker_heartbeats WHERE worker_id LIKE 'worker:%' AND stopped_at IS NULL AND heartbeat_at>clock_timestamp()-interval '5 seconds'")).rows[0].n, 0);
      observations.poolTwo = { batchExitCode: result.code, leaseRenewalDuringHttpObserved: true, unchangedFence: initial.fence, leasesReleased: true, applicationPoolMax: 2, workerConcurrency: 2, effectiveBatchLanes: 1, fixtureDatabaseConnectTimeoutMs: 30_000, fixtureFetchTimeoutMs: 60_000 };
      await resetQueues();
    });
  } finally {
    await stopOwnedChildren([...children]);
    for (const responses of held.values()) for (const response of responses) response.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (ownsOwner) {
      await sql('DELETE FROM state_operations WHERE owner_id=1');
      await sql('DELETE FROM owner WHERE id=1 AND email=$1', [owner.email]);
      await sql("UPDATE installation SET status='uninitialized' WHERE id=1");
      observations.cleanup = { ownerCount: (await sql('SELECT count(*)::int AS n FROM owner')).rows[0].n, activeHostLocks: (await sql("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND a.application_name='fever-host-coordinator'")).rows[0].n };
    }
    observations.finishedAt = new Date().toISOString(); observations.controlledHttpRequests = requests;
    const report = selectedCase ? `lifecycle-case-${selectedCase.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.json` : 'lifecycle-observations.json';
    await writeFile(`${evidenceDir}/${report}`, JSON.stringify(observations, null, 2) + '\n');
    await closeTarget(operator); await closeHostCoordinator(); await closeDatabase();
  }
});

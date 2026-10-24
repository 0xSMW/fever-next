import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { batchLaneCount, runRefreshBatch, type BatchDependencies } from '../worker/batch';

test('finite batch lanes reserve its session-lock connection from the application pool budget', () => {
  assert.equal(batchLaneCount(4, 2), 1);
  assert.equal(batchLaneCount(4, 3), 2);
  assert.equal(batchLaneCount(4, 10), 4);
  assert.equal(batchLaneCount(1, 2), 1);
  assert.throws(() => batchLaneCount(4, 1), /at least two/);
});

test('batch heartbeat uses the held session and finishes before unlock and release', async () => {
  const events: string[] = [];
  const emitter = new EventEmitter();
  const session = {
    query: async (query: string) => { events.push(query.includes('pg_try_') ? 'lock' : 'unlock'); return { rows: [{ locked: true }] }; },
    release: () => { events.push('release'); },
    on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter),
  } as unknown as Awaited<ReturnType<BatchDependencies['connect']>>;
  const deps: BatchDependencies = {
    connect: async () => session, context: async () => ({ ownerId: 1, installationId: 1 }),
    concurrency: () => batchLaneCount(4, 2), workerId: () => 'batch-fixture',
    enqueue: async () => {}, claimJob: async () => null, claimFeed: async () => null,
    refresh: async () => {}, renew: async () => {}, releaseJob: async () => {},
    releaseWorker: async () => { events.push('leases.release'); },
    heartbeat: async (_context, _worker, connection) => { assert.equal(connection, session); events.push('heartbeat'); },
    stopHeartbeat: async (_worker, connection) => {
      assert.equal(connection, session);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      events.push('heartbeat.stopped');
    },
  };
  assert.deepEqual(await runRefreshBatch({}, deps), { status: 'drained', jobs: 0, feeds: 0 });
  assert.deepEqual(events, ['lock', 'heartbeat', 'leases.release', 'heartbeat.stopped', 'unlock', 'release']);
});

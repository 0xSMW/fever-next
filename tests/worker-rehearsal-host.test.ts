import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { safeFetch, FetchError } from '../lib/ingest/http';
import { closeHostCoordinator, withWorkerHostSlot } from '../lib/ingest/host-limits';
import { closeDatabase, getPool } from '../lib/db/client';
import { randomUUID } from 'node:crypto';

const enabled = process.env.FEVER_WORKER_REHEARSAL === '1';
const node24 = process.execPath;

test('controlled HTTP host capacity and start spacing are shared across independent Node processes', { skip: !enabled, timeout: 40_000 }, async t => {
  assert.equal(process.versions.node.split('.')[0], '24');
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, 'ep-green-cake-arly1cyb.c-4.us-west-2.aws.neon.tech');
  let active = 0;
  let maximum = 0;
  const starts: number[] = [];
  const server = http.createServer((_request, response) => {
    active++;
    maximum = Math.max(maximum, active);
    starts.push(Date.now());
    setTimeout(() => { active--; response.end('<rss><channel/></rss>'); }, 2200);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const children = Array.from({ length: 3 }, () => {
    const child = spawn(node24, ['--network-family-autoselection-attempt-timeout=1000', '--conditions=react-server', '--import', 'tsx', 'tests/worker-rehearsal-child.ts', 'fetch', `http://127.0.0.1:${address.port}/feed`], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    return { child, done: once(child, 'exit').then(([code, signal]) => { assert.equal(signal, null); assert.equal(code, 0, output); }) };
  });
  t.after(() => { for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM'); });
  await Promise.all(children.map(child => child.done));
  const spacing = starts.slice(1).map((value, index) => value - starts[index]);
  t.diagnostic(JSON.stringify({ processes: 3, configuredCapacity: 2, observedMaximum: maximum, startSpacingMs: spacing }));
  assert.ok(maximum <= 2, `Observed ${maximum} concurrent requests across processes; configured capacity is two.`);
  assert.ok(spacing.every(value => value >= 450), `Request starts must be at least 500ms apart, allowing 50ms observation jitter: ${spacing}`);
});

test('a queued coordinator checkout is abortable and its late connection is returned', { skip: !enabled, timeout: 30_000 }, async t => {
  process.env.FEVER_WORKER_CONCURRENCY = '1';
  let arrived!: () => void;
  const received = new Promise<void>(resolve => { arrived = resolve; });
  let held: http.ServerResponse | undefined;
  const server = http.createServer((_request, response) => { held = response; arrived(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const alternate = `http://localhost:${address.port}`;
  const first = safeFetch(`${origin}/held`, { privateOrigins: [origin], coordinateWorkerHost: true, deadlineMs: 15_000 });
  t.after(async () => {
    held?.end('done');
    await first.catch(() => {});
    await closeHostCoordinator(); await closeDatabase();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await received;
  const started = Date.now();
  await assert.rejects(safeFetch(`${alternate}/waiting`, { privateOrigins: [alternate], coordinateWorkerHost: true, deadlineMs: 100 }), (error: unknown) => error instanceof FetchError && error.code === 'timeout');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `Queued checkout cancellation took ${elapsed}ms`);
  held!.end('done'); await first;
  await closeHostCoordinator();
  t.diagnostic(JSON.stringify({ queuedCheckoutTimeoutMs: elapsed, lateCheckoutReleased: true }));
});

test('terminating the exact coordinator session aborts its in-flight HTTP request and releases its advisory locks', { skip: !enabled, timeout: 30_000 }, async t => {
  let arrived!: () => void;
  const received = new Promise<void>(resolve => { arrived = resolve; });
  let held: http.ServerResponse | undefined;
  const server = http.createServer((_request, response) => { held = response; arrived(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  const host = `session-loss-${randomUUID()}`;
  const slot = `fever:http:host:${host}:slot:0`;
  const work = withWorkerHostSlot(host, controller.signal, () => controller.abort(), () => safeFetch(`${origin}/held`, { privateOrigins: [origin], signal: controller.signal, deadlineMs: 15_000 }));
  // Attach rejection observation before deliberately terminating the backend.
  const settled = work.then(() => ({ rejected: false }), () => ({ rejected: true }));
  t.after(async () => {
    controller.abort(); held?.destroy(); await settled;
    await closeHostCoordinator(); await closeDatabase();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await received;
  const lockQuery = `SELECT pid FROM pg_locks WHERE locktype='advisory'
    AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid
    AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1`;
  const locks = (await getPool().query(lockQuery, [slot])).rows;
  assert.equal(locks.length, 1, 'Identify exactly the owned coordinator backend by its unique advisory key');
  assert.equal((await getPool().query('SELECT pg_terminate_backend($1) AS terminated', [locks[0].pid])).rows[0].terminated, true);
  assert.equal((await settled).rejected, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal((await getPool().query(lockQuery, [slot])).rows.length, 0);
  t.diagnostic(JSON.stringify({ terminatedOwnedSession: true, httpAborted: true, remainingOwnedSlotLocks: 0 }));
});

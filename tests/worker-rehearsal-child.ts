import { safeFetch } from '../lib/ingest/http';
import { main } from '../worker';
import { closeDatabase } from '../lib/db/client';
import { closeHostCoordinator } from '../lib/ingest/host-limits';
import { readFile } from 'node:fs/promises';
import { refreshOne } from '../worker';
import { runRefreshBatch } from '../worker/batch';
import { LostLeaseError, type FeedLease } from '../lib/jobs/types';

async function run() {
if (process.env.FEVER_WORKER_REHEARSAL !== '1' || new URL(process.env.DATABASE_URL ?? '').hostname !== 'ep-green-cake-arly1cyb.c-4.us-west-2.aws.neon.tech') throw new Error('Refusing an unapproved worker rehearsal target.');
if (process.argv[2] === 'fetch') {
  const url = new URL(process.argv[3]);
  if (url.hostname !== '127.0.0.1') throw new Error('Worker rehearsal fetch must use the controlled loopback fixture.');
  try {
    await safeFetch(url.href, { privateOrigins: [url.origin], deadlineMs: 15_000, coordinateWorkerHost: true });
    console.log(JSON.stringify({ event: 'fixture.fetch_completed' }));
  } finally { await closeHostCoordinator(); await closeDatabase(); }
} else if (process.argv[2] === 'worker') await main();
else if (process.argv[2] === 'refresh' || process.argv[2] === 'batch') {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  try {
    if (process.argv[2] === 'batch') console.log(JSON.stringify({ event: 'fixture.batch_completed', ...await runRefreshBatch({ signal: controller.signal, budgetMs: 120_000 }) }));
    else {
      const path = process.argv[3];
      if (!path.startsWith('/tmp/feedafever-worker-rehearsal-20261024/') || !path.endsWith('.json')) throw new Error('Invalid private lease fixture path.');
      const lease = JSON.parse(await readFile(path, 'utf8')) as FeedLease;
      try { await refreshOne(lease, controller.signal); console.log(JSON.stringify({ event: 'fixture.refresh_completed' })); }
      catch (error) { if (!(error instanceof LostLeaseError)) throw error; console.log(JSON.stringify({ event: 'fixture.lease_lost' })); }
    }
  } finally { process.removeListener('SIGTERM', stop); await closeHostCoordinator(); await closeDatabase(); }
}
else throw new Error('Choose a worker rehearsal child mode.');
}
void run().catch(error => {
  const stack = String(error.stack ?? error.name).replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi, '[redacted]').slice(0, 2500);
  console.error(JSON.stringify({ event: 'fixture.failed', code: error.code ?? error.name, stack }));
  process.exitCode = 1;
});

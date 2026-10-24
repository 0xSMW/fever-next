import { pathToFileURL } from 'node:url';
import { getConfig } from '../lib/config';
import { closeDatabase } from '../lib/db/client';
import { logEvent } from '../lib/observability/log';
import { enqueueScheduledRefresh, installationContext } from '../lib/jobs';
import { claimJob, newWorkerId, releaseWorkerLeases } from '../lib/jobs/worker';
import { LostLeaseError, type InstallationContext } from '../lib/jobs/types';
import { drainJob } from './job';
import { heartbeat, stopHeartbeat } from '../lib/jobs/heartbeat';
import { pruneAuthRateLimits } from '../lib/auth/rate-limit';
import { closeHostCoordinator } from '../lib/ingest/host-limits';

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
async function lane(context: InstallationContext, workerId: string, signal: AbortSignal): Promise<void> {
  try {
    while (!signal.aborted) {
      try {
        const job = await claimJob(context, workerId);
        if (job) await drainJob(job, signal);
        else await pause(getConfig().workerPollMs, signal);
      } catch (error) {
        if (!(error instanceof LostLeaseError)) logEvent('worker.cycle_failed', { code: (error as { code?: string }).code ?? 'WORKER_ERROR' });
        await pause(getConfig().workerPollMs, signal);
      }
    }
  } finally { await releaseWorkerLeases(workerId); }
}
async function scheduler(context: InstallationContext, workerId: string, signal: AbortSignal): Promise<void> {
  let nextSchedule = 0; let nextPrune = 0;
  while (!signal.aborted) {
    try {
      await heartbeat(context, workerId);
      if (Date.now() >= nextPrune) { await pruneAuthRateLimits(); nextPrune = Date.now() + 3_600_000; }
      if (Date.now() >= nextSchedule) { await enqueueScheduledRefresh(context); nextSchedule = Date.now() + 60_000; }
    } catch (error) { logEvent('worker.scheduler_failed', { code: (error as { code?: string }).code ?? 'SCHEDULER_ERROR' }); }
    await pause(Math.min(getConfig().workerPollMs, 15_000), signal);
  }
}
/** Separately supervised process; never call from a route handler. */
export async function runWorker(signal: AbortSignal): Promise<void> {
  const context = await installationContext();
  const workerId = newWorkerId();
  logEvent('worker.started', { workerId, concurrency: getConfig().workerConcurrency });
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  signal.addEventListener('abort', stop, { once:true });
  if (signal.aborted) shutdown.abort();
  try {
    const tasks = [scheduler(context, workerId, shutdown.signal), ...Array.from({ length: getConfig().workerConcurrency }, (_, index) => lane(context, `${workerId}:${index}`, shutdown.signal))];
    const settled = await Promise.allSettled(tasks.map(task => task.catch(error => { shutdown.abort(); throw error; })));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status==='rejected');
    if (failed) throw failed.reason;
  } finally {
    signal.removeEventListener('abort', stop);
    await stopHeartbeat(workerId);
    logEvent('worker.stopped', { workerId });
  }
}
export async function main(): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await runWorker(shutdown.signal); }
  catch (error) { logEvent('worker.fatal', { code: (error as { code?: string }).code ?? 'WORKER_ERROR' }); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await closeHostCoordinator(); await closeDatabase(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

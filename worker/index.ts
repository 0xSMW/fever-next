import { pathToFileURL } from 'node:url';
import { getConfig } from '../lib/config';
import { closeDatabase, getPool } from '../lib/db/client';
import { logEvent } from '../lib/observability/log';
import { enqueueScheduledRefresh, installationContext } from '../lib/jobs';
import { claimFeed, claimJob, newWorkerId, releaseJob, releaseWorkerLeases, renewLease } from '../lib/jobs/worker';
import { LostLeaseError, type FeedLease, type InstallationContext, type JobLease } from '../lib/jobs/types';
import { prepareRefresh, commitRefresh, commitFailure } from '../lib/ingest/refresh';
import { pruneAuthRateLimits } from '../lib/auth/rate-limit';
import { FetchError } from '../lib/ingest/http';
import { closeHostCoordinator } from '../lib/ingest/host-limits';

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
export async function refreshOne(lease: FeedLease, shutdown: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  shutdown.addEventListener('abort', abort, { once: true });
  if (shutdown.aborted) controller.abort();
  let heartbeatError: unknown; let renewing: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = renewLease(lease.job, lease).catch(error => { heartbeatError = error; controller.abort(); }).finally(() => { renewing = undefined; });
  }, Math.max(1000, Math.floor(getConfig().leaseSeconds * 1000 / 3)));
  try {
    let outcome;
    try { outcome = await prepareRefresh(lease, controller.signal); }
    catch (error) {
      if (heartbeatError) throw heartbeatError;
      if (shutdown.aborted) throw new LostLeaseError();
      if (error instanceof LostLeaseError) throw error;
      const failure = error instanceof FetchError ? error : { code: 'processing', message: 'The feed could not be safely processed.' };
      clearInterval(timer); await renewing;
      if (heartbeatError) throw heartbeatError;
      await commitFailure(lease, failure);
      logEvent('worker.feed_failed', { jobId: lease.job.id, feedId: lease.feed.id, code: failure.code });
      return;
    }
    clearInterval(timer); await renewing;
    if (heartbeatError) throw heartbeatError;
    if (shutdown.aborted) throw new LostLeaseError();
    try { await commitRefresh(lease, outcome); }
    catch (error) {
      if (error instanceof LostLeaseError) throw error;
      // The merge transaction rolls back before this separate fenced failure record.
      await commitFailure(lease, { code: 'merge', message: 'The feed could not be merged safely. Existing articles were preserved.' });
      logEvent('worker.merge_failed', { jobId: lease.job.id, feedId: lease.feed.id, code: (error as { code?: string }).code ?? 'MERGE_ERROR' });
    }
  } finally { clearInterval(timer); shutdown.removeEventListener('abort', abort); }
}
async function runJob(job: JobLease, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const feed = await claimFeed(job);
    if (!feed) { await releaseJob(job); return; }
    await refreshOne(feed, signal);
    await renewLease(job);
  }
}
async function lane(context: InstallationContext, workerId: string, signal: AbortSignal): Promise<void> {
  try {
    while (!signal.aborted) {
      try {
        const job = await claimJob(context, workerId);
        if (job) await runJob(job, signal);
        else await pause(getConfig().workerPollMs, signal);
      } catch (error) {
        if (!(error instanceof LostLeaseError)) logEvent('worker.cycle_failed', { code: (error as { code?: string }).code ?? 'WORKER_ERROR' });
        await pause(getConfig().workerPollMs, signal);
      }
    }
  } finally { await releaseWorkerLeases(workerId); }
}
async function heartbeat(context: InstallationContext, workerId: string): Promise<void> {
  await getPool().query(`INSERT INTO worker_heartbeats(worker_id,owner_id) VALUES($1,$2)
    ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at=clock_timestamp(),stopped_at=NULL`, [workerId, context.ownerId]);
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
    await getPool().query('UPDATE worker_heartbeats SET stopped_at=clock_timestamp(),active_job_id=NULL WHERE worker_id=$1', [workerId]);
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

import type { PoolClient } from 'pg';
import { getConfig } from '../lib/config';
import { getPool } from '../lib/db/client';
import { enqueueScheduledRefresh, installationContext } from '../lib/jobs';
import { claimFeed, claimJob, newWorkerId, releaseJob, releaseWorkerLeases, renewLease } from '../lib/jobs/worker';
import { LostLeaseError, type FeedLease, type InstallationContext, type JobLease } from '../lib/jobs/types';
import { refreshOne } from './refresh';
import { drainJob } from './job';
import { heartbeat, stopHeartbeat } from '../lib/jobs/heartbeat';

const LOCK = "hashtextextended('fever:serverless-refresh',0)";
const DEFAULT_BUDGET_MS = 210_000;
export class BatchConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'BatchConfigurationError'; }
}
export function requireBatchPoolCapacity(poolMax: number): void {
  if (!Number.isInteger(poolMax) || poolMax < 2) throw new BatchConfigurationError('Scheduled refresh requires a database pool of at least two connections.');
}
export function batchLaneCount(workerConcurrency: number, poolMax: number): number {
  requireBatchPoolCapacity(poolMax);
  if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 32) throw new RangeError('Invalid batch concurrency.');
  return Math.min(workerConcurrency, poolMax - 1);
}
export interface BatchResult { status: 'drained' | 'budget_exhausted' | 'cancelled' | 'locked'; jobs: number; feeds: number; }
export interface BatchOptions { budgetMs?: number; signal?: AbortSignal; }
export interface BatchDependencies {
  connect(): Promise<Pick<PoolClient, 'query' | 'release' | 'on' | 'removeListener'>>;
  context(): Promise<InstallationContext>;
  concurrency(): number;
  workerId(): string;
  enqueue(context: InstallationContext): Promise<unknown>;
  claimJob(context: InstallationContext, workerId: string): Promise<JobLease | null>;
  claimFeed(job: JobLease): Promise<FeedLease | null>;
  refresh(feed: FeedLease, signal: AbortSignal): Promise<void>;
  renew(job: JobLease): Promise<void>;
  releaseJob(job: JobLease): Promise<void>;
  releaseWorker(workerId: string): Promise<void>;
  heartbeat(context: InstallationContext, workerId: string, session?: Pick<PoolClient, 'query'>): Promise<void>;
  stopHeartbeat(workerId: string, session?: Pick<PoolClient, 'query'>): Promise<void>;
}
const dependencies: BatchDependencies = {
  connect: () => {
    const config = getConfig();
    requireBatchPoolCapacity(config.databasePoolMax);
    const host = new URL(config.databaseUrl).hostname;
    if (host.endsWith('.neon.tech') && host.includes('-pooler.')) throw new BatchConfigurationError('Scheduled refresh requires a session-preserving PostgreSQL connection.');
    return getPool().connect();
  }, context: installationContext,
  concurrency: () => { const config = getConfig(); return batchLaneCount(config.workerConcurrency, config.databasePoolMax); }, workerId: newWorkerId,
  enqueue: enqueueScheduledRefresh, claimJob, claimFeed, refresh: refreshOne,
  renew: renewLease, releaseJob, releaseWorker: releaseWorkerLeases,
  heartbeat, stopHeartbeat,
};

/** Finite serverless drain. The session lock uses a dedicated checked-out connection. */
export async function runRefreshBatch(options: BatchOptions = {}, deps: BatchDependencies = dependencies): Promise<BatchResult> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > 240_000) throw new RangeError('The batch budget must be between one and 240000 milliseconds.');
  const controller = new AbortController();
  let budgetExpired = false;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => { budgetExpired = true; controller.abort(); }, budgetMs);
  let client: Awaited<ReturnType<BatchDependencies['connect']>> | undefined;
  let locked = false;
  let workerId: string | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatPending: Promise<void> | undefined;
  let heartbeatError: unknown;
  let lockConnectionError: Error | undefined;
  const connectionFailed = (error: Error) => { lockConnectionError = error; controller.abort(); };
  const laneIds: string[] = [];
  const result: BatchResult = { status: 'drained', jobs: 0, feeds: 0 };
  try {
    if (controller.signal.aborted) return { ...result, status: 'cancelled' };
    client = await deps.connect();
    client.on('error', connectionFailed);
    const lock = await client.query(`SELECT pg_try_advisory_lock(${LOCK}) AS locked`);
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { ...result, status: 'locked' };
    if (controller.signal.aborted) return { ...result, status: budgetExpired ? 'budget_exhausted' : 'cancelled' };
    const context = await deps.context();
    workerId = deps.workerId();
    await deps.heartbeat(context, workerId, client);
    heartbeatTimer = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = deps.heartbeat(context, workerId!, client).catch(error => { heartbeatError = error; controller.abort(); }).finally(() => { heartbeatPending = undefined; });
    }, 15_000);
    if (!controller.signal.aborted) await deps.enqueue(context);
    const concurrency = deps.concurrency();
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new RangeError('Invalid batch concurrency.');
    const lanes = Array.from({ length: concurrency }, (_, index) => {
      const laneId = `${workerId}:${index}`;
      laneIds.push(laneId);
      return (async () => {
        while (!controller.signal.aborted) {
          const job = await deps.claimJob(context, laneId);
          if (!job) return;
          result.jobs++;
          await drainJob(job, controller.signal, { ...deps, completedFeed: () => { result.feeds++; } });
        }
      })().catch(error => {
        if (controller.signal.aborted && error instanceof LostLeaseError) return;
        controller.abort();
        throw error;
      });
    });
    const settled = await Promise.allSettled(lanes);
    const failed = settled.find((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (failed) throw failed.reason;
    if (lockConnectionError) throw lockConnectionError;
    if (heartbeatError) throw heartbeatError;
    result.status = budgetExpired ? 'budget_exhausted' : controller.signal.aborted ? 'cancelled' : 'drained';
    return result;
  } finally {
    clearTimeout(timer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    await heartbeatPending;
    // Always attempt every cleanup, including when one lease release fails.
    const cleanup = await Promise.allSettled([
      ...laneIds.map(id => deps.releaseWorker(id)),
      ...(workerId ? [deps.stopHeartbeat(workerId, client)] : []),
    ]);
    let unlockError: Error | undefined;
    if (client) {
      try { if (locked) await client.query(`SELECT pg_advisory_unlock(${LOCK})`); }
      catch (error) { unlockError = error instanceof Error ? error : new Error('Unable to release the refresh lock.'); }
      finally { client.removeListener('error', connectionFailed); client.release(unlockError ?? lockConnectionError); }
    }
    const failedCleanup = cleanup.find((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (unlockError) throw unlockError;
    if (failedCleanup) throw failedCleanup.reason;
  }
}

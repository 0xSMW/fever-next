import { claimFeed, releaseJob, renewLease } from '../lib/jobs/worker';
import type { FeedLease, JobLease } from '../lib/jobs/types';
import { refreshOne } from './refresh';

export interface JobOperations {
  claimFeed(job: JobLease): Promise<FeedLease | null>;
  refresh(feed: FeedLease, signal: AbortSignal): Promise<void>;
  renew(job: JobLease): Promise<void>;
  releaseJob(job: JobLease): Promise<void>;
  completedFeed?(): void;
}
const defaults: JobOperations = { claimFeed, refresh: refreshOne, renew: renewLease, releaseJob };
/** Fully drained jobs release here; interrupted leases remain the supervisor's cleanup responsibility. */
export async function drainJob(job: JobLease, signal: AbortSignal, operations: JobOperations = defaults): Promise<number> {
  let count = 0;
  while (!signal.aborted) {
    const feed = await operations.claimFeed(job);
    if (!feed) { await operations.releaseJob(job); break; }
    await operations.refresh(feed, signal);
    count++;
    operations.completedFeed?.();
    if (!signal.aborted) await operations.renew(job);
  }
  return count;
}

import { getConfig } from '../lib/config';
import { logEvent } from '../lib/observability/log';
import { renewLease } from '../lib/jobs/worker';
import { LostLeaseError, type FeedLease } from '../lib/jobs/types';
import { prepareRefresh, commitRefresh, commitFailure } from '../lib/ingest/refresh';
import { FetchError } from '../lib/ingest/http';

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

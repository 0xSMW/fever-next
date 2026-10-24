import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client';
import { getConfig } from '../config';
import { safeInteger, toId } from '../db/numbers';
import type { FeedRow } from '../db/schema';
import { transaction, requireReady } from './transactions';
import { LostLeaseError, type FeedLease, type InstallationContext, type JobLease } from './types';

export function newWorkerId(): string { return `worker:${process.pid}:${randomUUID()}`; }
export async function claimJob(context: InstallationContext, workerId: string): Promise<JobLease | null> {
  return transaction(async client => {
    await requireReady(client, context.ownerId);
    const exhausted = await client.query(`UPDATE refresh_jobs SET status='failed',error='Worker restart limit exceeded.',finished_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,fence=fence+1
      WHERE owner_id=$1 AND status IN ('queued','running') AND attempts>=max_attempts AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp()) RETURNING id`, [context.ownerId]);
    for (const abandoned of exhausted.rows) {
      await client.query("UPDATE feed_fetch_state s SET lease_owner=NULL,lease_expires_at=NULL,fence=s.fence+1 FROM job_feed_results r WHERE r.job_id=$1 AND r.feed_id=s.feed_id AND r.status='running' AND s.fence=r.fence", [abandoned.id]);
      await client.query("UPDATE job_feed_results SET status='failed',finished_at=clock_timestamp(),error='Worker restart limit exceeded.' WHERE job_id=$1 AND status IN ('queued','running','retry')", [abandoned.id]);
      await client.query("UPDATE refresh_jobs SET total_feeds=(SELECT count(*) FROM job_feed_results WHERE job_id=$1),completed_feeds=(SELECT count(*) FROM job_feed_results WHERE job_id=$1),failed_feeds=(SELECT count(*) FROM job_feed_results WHERE job_id=$1 AND status='failed'),current_feed_id=NULL,current_feed_title=NULL WHERE id=$1", [abandoned.id]);
    }
    const result = await client.query(`WITH candidate AS (
      SELECT id FROM refresh_jobs WHERE owner_id=$1 AND status IN ('queued','running') AND cancel_requested_at IS NULL
        AND due_at<=clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at<clock_timestamp()) AND attempts<max_attempts
      ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE refresh_jobs j SET status='running',lease_owner=$2,lease_expires_at=clock_timestamp()+($3*interval '1 second'),
        fence=fence+1,attempts=attempts+1,started_at=COALESCE(started_at,clock_timestamp()) FROM candidate c WHERE j.id=c.id RETURNING j.*`, [context.ownerId, workerId, getConfig().leaseSeconds]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { id: toId(row.id), ownerId: context.ownerId, workerId, fence: safeInteger(row.fence), force: row.force, faviconOnly: row.favicon_only };
  });
}
export async function assertLease(client: PoolClient, job: JobLease, feed?: FeedLease): Promise<void> {
  await requireReady(client, job.ownerId);
  const result = await client.query("SELECT 1 FROM refresh_jobs WHERE id=$1 AND owner_id=$2 AND lease_owner=$3 AND fence=$4 AND lease_expires_at>clock_timestamp() AND status='running' AND cancel_requested_at IS NULL FOR UPDATE", [job.id, job.ownerId, job.workerId, job.fence]);
  if (!result.rowCount) throw new LostLeaseError();
  if (feed) {
    const state = await client.query("SELECT 1 FROM feed_fetch_state WHERE feed_id=$1 AND lease_owner=$2 AND fence=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE", [feed.feed.id, job.workerId, feed.fence]);
    if (!state.rowCount) throw new LostLeaseError();
    const owned = await client.query("SELECT 1 FROM feeds f LEFT JOIN feed_credentials c ON c.feed_id=f.id WHERE f.id=$1 AND f.owner_id=$2 AND f.url=$3 AND c.ciphertext IS NOT DISTINCT FROM $4::text FOR UPDATE OF f", [feed.feed.id, job.ownerId, feed.feed.url, feed.credentialCiphertext]);
    if (!owned.rowCount) throw new LostLeaseError();
    const credential = await client.query('SELECT ciphertext FROM feed_credentials WHERE feed_id=$1 FOR SHARE', [feed.feed.id]);
    if ((credential.rows[0]?.ciphertext ?? null) !== feed.credentialCiphertext) throw new LostLeaseError();
  }
}
function feedRow(row: Record<string, unknown>): FeedRow {
  return {
    id: toId(row.id), ownerId: toId(row.owner_id), url: String(row.url), originalUrl: String(row.original_url), canonicalUrl: String(row.canonical_url), urlKey: String(row.url_key), urlChecksum: safeInteger(row.url_checksum), title: String(row.title), customTitle: row.custom_title as string | null, siteUrl: String(row.site_url), domain: String(row.domain), faviconId: row.favicon_id == null ? null : toId(row.favicon_id), requiresAuth: row.requires_auth as boolean, isSpark: row.is_spark as boolean, preventsHotlinking: row.prevents_hotlinking as boolean, itemExcerpts: Number(row.item_excerpts), itemAllows: Number(row.item_allows), unreadCounts: Number(row.unread_counts), sortOrder: Number(row.sort_order), createdAt: new Date(row.created_at as string), updatedAt: new Date(row.updated_at as string),
  };
}
export async function claimFeed(job: JobLease): Promise<FeedLease | null> {
  return transaction(async client => {
    await assertLease(client, job);
    await client.query('INSERT INTO feed_fetch_state(feed_id) SELECT feed_id FROM job_feed_results WHERE job_id=$1 ON CONFLICT(feed_id) DO NOTHING', [job.id]);
    if (!job.force && !job.faviconOnly) await client.query(`UPDATE job_feed_results r SET status='skipped',finished_at=clock_timestamp()
      FROM feed_fetch_state s,refresh_jobs j WHERE r.job_id=$1 AND j.id=r.job_id AND r.feed_id=s.feed_id AND r.status='queued'
      AND s.last_success_at>=floor(extract(epoch FROM j.created_at)) AND s.next_attempt_at>floor(extract(epoch FROM clock_timestamp()))`, [job.id]);
    const result = await client.query(`SELECT r.id AS result_id,r.attempts,s.*,row_to_json(f) AS feed,c.ciphertext,c.key_id,p.refresh_interval,p.item_expiration
      FROM job_feed_results r JOIN feeds f ON f.id=r.feed_id JOIN feed_fetch_state s ON s.feed_id=f.id
      JOIN reader_preferences p ON p.owner_id=f.owner_id LEFT JOIN feed_credentials c ON c.feed_id=f.id
      WHERE r.job_id=$1 AND f.owner_id=$2 AND r.status IN ('queued','running','retry')
        AND (s.lease_expires_at IS NULL OR s.lease_expires_at<clock_timestamp())
        AND (r.status<>'retry' OR s.next_attempt_at<=floor(extract(epoch FROM clock_timestamp())))
      ORDER BY f.is_spark ASC,s.last_refreshed_at ASC,f.id ASC FOR UPDATE OF r,s SKIP LOCKED LIMIT 1`, [job.id, job.ownerId]);
    if (!result.rowCount) return null;
    const row = result.rows[0]; const feed = feedRow(row.feed);
    const state = await client.query("UPDATE feed_fetch_state SET lease_owner=$2,lease_expires_at=clock_timestamp()+($3*interval '1 second'),fence=fence+1,last_refreshed_at=floor(extract(epoch FROM clock_timestamp())),updated_at=clock_timestamp() WHERE feed_id=$1 RETURNING fence", [feed.id, job.workerId, getConfig().leaseSeconds]);
    const fence = safeInteger(state.rows[0].fence);
    await client.query("UPDATE job_feed_results SET status='running',started_at=COALESCE(started_at,clock_timestamp()),finished_at=NULL,attempts=attempts+1,fence=$2 WHERE id=$1", [row.result_id, fence]);
    await client.query('UPDATE refresh_jobs SET current_feed_id=$2,current_feed_title=$3 WHERE id=$1', [job.id, feed.id, feed.customTitle || feed.title]);
    return { job, resultId: toId(row.result_id), feed, fence, attempts: safeInteger(row.attempts) + 1, etag: row.etag, lastModified: row.last_modified, failureCount: safeInteger(row.failure_count), credentialCiphertext: row.ciphertext ?? null, credentialKeyId: row.key_id ?? null, intervalMinutes: safeInteger(row.refresh_interval), expirationWeeks: safeInteger(row.item_expiration) };
  });
}
export async function renewLease(job: JobLease, feed?: FeedLease): Promise<void> {
  await transaction(async client => {
    await assertLease(client, job, feed);
    await client.query("UPDATE refresh_jobs SET lease_expires_at=clock_timestamp()+($2*interval '1 second') WHERE id=$1", [job.id, getConfig().leaseSeconds]);
    if (feed) await client.query("UPDATE feed_fetch_state SET lease_expires_at=clock_timestamp()+($2*interval '1 second') WHERE feed_id=$1", [feed.feed.id, getConfig().leaseSeconds]);
  });
}
export async function updateJobProgress(client: PoolClient, job: JobLease): Promise<void> {
  await client.query(`UPDATE refresh_jobs SET total_feeds=(SELECT count(*) FROM job_feed_results WHERE job_id=$1),
    completed_feeds=(SELECT count(*) FROM job_feed_results WHERE job_id=$1 AND status IN ('completed','failed','skipped')),
    failed_feeds=(SELECT count(*) FROM job_feed_results WHERE job_id=$1 AND status='failed'),current_feed_id=NULL,current_feed_title=NULL WHERE id=$1`, [job.id]);
}
/** Finish an exhausted job, or release it until the earliest remaining retry/lease. */
export async function releaseJob(job: JobLease): Promise<void> {
  await transaction(async client => {
    await assertLease(client, job);
    await updateJobProgress(client, job);
    const pending = await client.query(`SELECT r.status,s.next_attempt_at,s.lease_expires_at FROM job_feed_results r LEFT JOIN feed_fetch_state s ON s.feed_id=r.feed_id WHERE r.job_id=$1 AND r.status IN ('queued','running','retry')`, [job.id]);
    if (!pending.rowCount) {
      await client.query("UPDATE refresh_jobs SET status=CASE WHEN failed_feeds>0 THEN 'failed' ELSE 'completed' END,error=CASE WHEN failed_feeds>0 THEN failed_feeds::text || ' feed(s) could not be refreshed.' ELSE NULL END,finished_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]);
    } else {
      const now = Date.now();
      const earliest = Math.min(...pending.rows.map(row => Math.max(now + 1000, row.status === 'retry' ? safeInteger(row.next_attempt_at ?? 0) * 1000 : now, row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : now)));
      // A planned yield is not a crash/restart attempt.
      await client.query("UPDATE refresh_jobs SET status='queued',due_at=$2,lease_owner=NULL,lease_expires_at=NULL,attempts=GREATEST(attempts-1,0) WHERE id=$1", [job.id, new Date(earliest)]);
    }
  });
}
export async function releaseWorkerLeases(workerId: string): Promise<void> {
  await transaction(async client => {
    // Invalidate fences before relinquishing work on graceful shutdown.
    await client.query("UPDATE refresh_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,fence=fence+1,attempts=GREATEST(attempts-1,0) WHERE lease_owner=$1 AND status='running'", [workerId]);
    await client.query('UPDATE feed_fetch_state SET lease_owner=NULL,lease_expires_at=NULL,fence=fence+1 WHERE lease_owner=$1', [workerId]);
  });
}
export async function workerHealth(): Promise<{ lastActivityAt: number; runningJobs: number; queuedJobs: number }> {
  const result = await getPool().query("SELECT COALESCE(max(extract(epoch FROM COALESCE(finished_at,started_at,created_at))),0) AS activity,count(*) FILTER(WHERE status='running') AS running,count(*) FILTER(WHERE status='queued') AS queued FROM refresh_jobs");
  return { lastActivityAt: Math.floor(Number(result.rows[0].activity)), runningJobs: safeInteger(result.rows[0].running), queuedJobs: safeInteger(result.rows[0].queued) };
}

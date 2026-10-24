import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client';
import { getConfig } from '../config';
import { safeInteger, toId } from '../db/numbers';
import type { RefreshJobDTO } from '../contracts';
import { getCheckedSessionEpoch } from '../auth/owner';
import { transaction, requireReady } from './transactions';
import { JobError, type InstallationContext, type OwnerContext, type RefreshScope } from './types';
export { JobError, LostLeaseError } from './types';
export type { RefreshScope, InstallationContext, JobLease, FeedLease } from './types';

type JobRecord = Record<string, unknown>;
const epoch = (value: unknown): number | null => value == null ? null : Math.floor(new Date(value as string | Date).getTime() / 1000);
export function jobDTO(row: JobRecord): RefreshJobDTO {
  return { id: toId(row.id), status: row.status as RefreshJobDTO['status'], totalFeeds: safeInteger(row.total_feeds), completedFeeds: safeInteger(row.completed_feeds), currentFeedId: row.current_feed_id == null ? null : toId(row.current_feed_id), currentFeedTitle: row.current_feed_title as string | null, error: row.error as string | null, createdAt: epoch(row.created_at)!, startedAt: epoch(row.started_at), finishedAt: epoch(row.finished_at) };
}
async function assertOwner(owner: OwnerContext): Promise<void> {
  const auth = await import('../auth/owner');
  await auth.assertOwner(owner);
}
async function requireOwner(client: PoolClient, owner: OwnerContext): Promise<void> {
  toId(owner.id);
  // Match auth/domain lock order and keep authorization valid through commit.
  await requireReady(client, owner.id);
  const result = await client.query(`SELECT 1 FROM owner WHERE id=$1 AND email=$2 AND recovery_required=false
    AND ($3::bigint IS NULL OR auth_epoch=$3) FOR SHARE`, [owner.id, owner.email, getCheckedSessionEpoch(owner) ?? null]);
  if (!result.rowCount) throw new JobError('UNAUTHORIZED', 'Authentication required.', 401);
}
function validateScope(scope: RefreshScope): RefreshScope {
  if (!scope || !['all', 'group', 'feed'].includes(scope.scope)) throw new JobError('INVALID_SCOPE', 'Choose all feeds, a group, or a feed.');
  if (scope.scope !== 'all') toId(scope.id);
  else if (scope.id !== undefined) throw new JobError('INVALID_SCOPE', 'An all-feeds refresh has no scope ID.');
  if (scope.force !== undefined && typeof scope.force !== 'boolean') throw new JobError('INVALID_SCOPE', 'Force must be a boolean.');
  if (scope.faviconOnly !== undefined && typeof scope.faviconOnly !== 'boolean') throw new JobError('INVALID_SCOPE', 'Favicon-only must be a boolean.');
  return scope;
}
async function enqueue(client: PoolClient, ownerId: number, input: RefreshScope, requester: 'owner' | 'scheduler'): Promise<RefreshJobDTO> {
  const scope = validateScope(input);
  await requireReady(client, ownerId);
  if (scope.scope !== 'all') {
    const result = await client.query(`SELECT 1 FROM ${scope.scope === 'feed' ? 'feeds' : 'groups'} WHERE id=$1 AND owner_id=$2`, [scope.id, ownerId]);
    if (!result.rowCount) throw new JobError('NOT_FOUND', 'The selected feed or group does not exist.', 404);
  }
  const force = scope.force === true || scope.scope === 'group';
  const faviconOnly = scope.faviconOnly === true;
  const deduplicationKey = createHash('sha256').update(JSON.stringify([ownerId, scope.scope, scope.id ?? null, force, faviconOnly])).digest('hex');
  // Serialize identical enqueue attempts, including empty jobs that finish immediately.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fever:enqueue:${deduplicationKey}`]);
  const active = await client.query("SELECT * FROM refresh_jobs WHERE owner_id=$1 AND deduplication_key=$2 AND status IN ('queued','running')", [ownerId, deduplicationKey]);
  if (active.rowCount) return jobDTO(active.rows[0]);
  const created = await client.query('INSERT INTO refresh_jobs(owner_id,requester,scope,scope_id,force,favicon_only,deduplication_key,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [ownerId, requester, scope.scope, scope.id ?? null, force, faviconOnly, deduplicationKey, getConfig().maxJobAttempts]);
  const id = toId(created.rows[0].id);
  await client.query(`INSERT INTO job_feed_results(job_id,feed_id)
    SELECT $1,f.id FROM feeds f LEFT JOIN feed_fetch_state s ON s.feed_id=f.id
    WHERE f.owner_id=$2 AND ($3='all' OR ($3='feed' AND f.id=$4) OR ($3='group' AND NOT f.is_spark AND EXISTS(SELECT 1 FROM feed_groups fg WHERE fg.feed_id=f.id AND fg.group_id=$4)))
      AND ($5 OR COALESCE(s.next_attempt_at,0)<=floor(extract(epoch FROM clock_timestamp())))
    ORDER BY f.is_spark ASC,COALESCE(s.last_refreshed_at,0) ASC,f.id ASC`, [id, ownerId, scope.scope, scope.id ?? null, force || faviconOnly]);
  const updated = await client.query(`UPDATE refresh_jobs SET total_feeds=(SELECT count(*) FROM job_feed_results WHERE job_id=$1),
    status=CASE WHEN EXISTS(SELECT 1 FROM job_feed_results WHERE job_id=$1) THEN 'queued' ELSE 'completed' END,
    finished_at=CASE WHEN EXISTS(SELECT 1 FROM job_feed_results WHERE job_id=$1) THEN NULL ELSE clock_timestamp() END WHERE id=$1 RETURNING *`, [id]);
  return jobDTO(updated.rows[0]);
}
export async function enqueueRefresh(owner: OwnerContext, scope: RefreshScope): Promise<RefreshJobDTO> {
  await assertOwner(owner);
  return transaction(async client => { await requireOwner(client, owner); return enqueue(client, owner.id, scope, 'owner'); });
}
export async function enqueueInstallationRefresh(context: InstallationContext, scope: RefreshScope): Promise<RefreshJobDTO> {
  if (context.installationId !== 1) throw new JobError('INVALID_INSTALLATION', 'Invalid installation context.');
  return transaction(client => enqueue(client, toId(context.ownerId), scope, 'owner'));
}
export async function enqueueScheduledRefresh(context: InstallationContext): Promise<RefreshJobDTO | null> {
  if (context.installationId !== 1) throw new JobError('INVALID_INSTALLATION', 'Invalid installation context.');
  return transaction(async client => {
    await requireReady(client, context.ownerId);
    const due = await client.query('SELECT 1 FROM feeds f LEFT JOIN feed_fetch_state s ON s.feed_id=f.id WHERE f.owner_id=$1 AND COALESCE(s.next_attempt_at,0)<=floor(extract(epoch FROM clock_timestamp())) LIMIT 1', [context.ownerId]);
    return due.rowCount ? enqueue(client, toId(context.ownerId), { scope: 'all' }, 'scheduler') : null;
  });
}
export async function getRefreshJob(owner: OwnerContext, id?: number): Promise<RefreshJobDTO | null> {
  await assertOwner(owner);
  return transaction(async client => {
    await requireOwner(client, owner);
    if (id !== undefined) toId(id);
    const result = await client.query('SELECT * FROM refresh_jobs WHERE owner_id=$1 AND ($2::bigint IS NULL OR id=$2) ORDER BY created_at DESC,id DESC LIMIT 1', [owner.id, id ?? null]);
    return result.rowCount ? jobDTO(result.rows[0]) : null;
  });
}
export async function cancelRefresh(owner: OwnerContext, id: number): Promise<RefreshJobDTO> {
  await assertOwner(owner);
  toId(id);
  return transaction(async client => {
    await requireOwner(client, owner);
    const result = await client.query('SELECT * FROM refresh_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, owner.id]);
    if (!result.rowCount) throw new JobError('NOT_FOUND', 'The refresh job does not exist.', 404);
    if (!['queued', 'running'].includes(result.rows[0].status)) return jobDTO(result.rows[0]);
    // Invalidate the job fence immediately. Any in-flight network response is discarded.
    const updated = await client.query("UPDATE refresh_jobs SET cancel_requested_at=clock_timestamp(),status='cancelled',finished_at=clock_timestamp(),fence=fence+1,lease_owner=NULL,lease_expires_at=NULL,current_feed_id=NULL,current_feed_title=NULL WHERE id=$1 RETURNING *", [id]);
    await client.query("UPDATE feed_fetch_state s SET lease_owner=NULL,lease_expires_at=NULL,fence=s.fence+1 FROM job_feed_results r WHERE r.job_id=$1 AND r.feed_id=s.feed_id AND r.status='running' AND s.fence=r.fence", [id]);
    await client.query("UPDATE job_feed_results SET status='cancelled',finished_at=clock_timestamp() WHERE job_id=$1 AND status IN ('queued','running','retry')", [id]);
    return jobDTO(updated.rows[0]);
  });
}
export async function installationContext(): Promise<InstallationContext> {
  const result = await getPool().query("SELECT o.id FROM owner o JOIN installation i ON i.id=1 AND i.status='ready' LIMIT 1");
  if (!result.rowCount) throw new JobError('INSTALLATION_UNAVAILABLE', 'The installation is not ready for worker operation.', 503);
  return { ownerId: toId(result.rows[0].id), installationId: 1 };
}

export async function getWorkerStatus(): Promise<{status:'healthy'|'stale'|'unknown';lastHeartbeatAt:number|null;workers:number;runningJobs:number;queuedJobs:number}> {
  const freshness = Math.max(60, Math.ceil(getConfig().workerPollMs / 1000) * 3);
  const result = await getPool().query(`SELECT max(heartbeat_at) AS last,count(*) FILTER(WHERE stopped_at IS NULL AND heartbeat_at>clock_timestamp()-($1*interval '1 second')) AS workers FROM worker_heartbeats`, [freshness]);
  const jobs = await getPool().query("SELECT count(*) FILTER(WHERE status='running') AS running,count(*) FILTER(WHERE status='queued') AS queued FROM refresh_jobs");
  const workers = safeInteger(result.rows[0].workers);
  return { status:workers>0?'healthy':result.rows[0].last?'stale':'unknown',lastHeartbeatAt:epoch(result.rows[0].last),workers,runningJobs:safeInteger(jobs.rows[0].running),queuedJobs:safeInteger(jobs.rows[0].queued) };
}

import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { assertOwner, type OwnerContext } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { feeds, feedFetchState, installation, maintenanceBackups, refreshJobs } from "@/lib/db/schema";
import { SCHEMA_VERSION } from "@/lib/config";
import { dateToEpoch, toCount } from "@/lib/db/numbers";
import { getWorkerStatus } from "@/lib/jobs";

function safeError(value: string | null): string | null {
  return value ? value.slice(0, 500).replace(/https?:\/\/\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:password|token|secret|api.?key|authorization)\s*[:=]\s*\S+/gi, "[redacted]") : null;
}
export async function readiness(): Promise<boolean> {
  try {
    const [state] = await getDb().select({ status: installation.status, version: installation.schemaVersion }).from(installation).where(eq(installation.id, 1)).limit(1);
    return state?.status === "ready" && state.version === SCHEMA_VERSION;
  } catch { return false; }
}
export async function diagnostics(owner: OwnerContext) {
  await assertOwner(owner);
  const db = getDb();
  const [state] = await db.select({ status: installation.status, schemaVersion: installation.schemaVersion, sourceVersion: installation.sourceVersion, installedAt: installation.installedAt, provenance: installation.migrationProvenance }).from(installation).where(eq(installation.id, 1)).limit(1);
  const [latestJob] = await db.select().from(refreshJobs).where(eq(refreshJobs.ownerId, owner.id)).orderBy(desc(refreshJobs.id)).limit(1);
  const [latestSnapshot] = await db.select({ id: maintenanceBackups.id, createdAt: maintenanceBackups.createdAt, operation: maintenanceBackups.operation }).from(maintenanceBackups).where(eq(maintenanceBackups.ownerId, owner.id)).orderBy(desc(maintenanceBackups.id)).limit(1);
  const feedRows = await db.select({ id: feeds.id, title: feeds.title, requiresAuth: feeds.requiresAuth, status: feedFetchState.status, lastError: feedFetchState.lastError, lastStatusCode: feedFetchState.lastStatusCode, lastRefreshedAt: feedFetchState.lastRefreshedAt, lastSuccessAt: feedFetchState.lastSuccessAt, failureCount: feedFetchState.failureCount }).from(feeds).leftJoin(feedFetchState, eq(feedFetchState.feedId, feeds.id)).where(eq(feeds.ownerId, owner.id)).orderBy(desc(feedFetchState.failureCount), feeds.id).limit(1000);
  const counts = await db.execute<{ feeds: string; items: string; saved: string; jobs: string }>(sql`select (select count(*) from feeds where owner_id=${owner.id})::text as feeds, (select count(*) from items i join feeds f on f.id=i.feed_id where f.owner_id=${owner.id})::text as items, (select count(*) from items i join feeds f on f.id=i.feed_id where f.owner_id=${owner.id} and i.is_saved)::text as saved, (select count(*) from refresh_jobs where owner_id=${owner.id} and status in ('queued','running'))::text as jobs`);
  const versions = await db.execute<{ version: string }>(sql`select current_setting('server_version') as version`);
  const storage = await db.execute<{ live: string; dead: string; lastAnalyze: string | null; lastVacuum: string | null }>(sql`select coalesce(sum(n_live_tup),0)::text as live, coalesce(sum(n_dead_tup),0)::text as dead, max(coalesce(last_autoanalyze,last_analyze))::text as "lastAnalyze", max(coalesce(last_autovacuum,last_vacuum))::text as "lastVacuum" from pg_stat_user_tables where relname in ('feeds','items','link_occurrences','refresh_jobs','state_operations')`);
  const count = counts.rows[0];
  const worker = await getWorkerStatus();
  const backup = state?.provenance.operatorBackup;
  const restore = state?.provenance.operatorRestore;
  const completion = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("completedAt" in entry) || typeof entry.completedAt !== "string") return null;
    const value = new Date(entry.completedAt).getTime();
    return Number.isFinite(value) && value <= Date.now() + 60_000 ? Math.floor(value / 1000) : null;
  };
  const lastBackupAt = completion(backup), lastRestoreAt = completion(restore);
  return {
    database: { connected: true, schemaVersion: state?.schemaVersion, expectedSchemaVersion: SCHEMA_VERSION, version: versions.rows[0]?.version, counts: { feeds: toCount(count?.feeds ?? 0), items: toCount(count?.items ?? 0), saved: toCount(count?.saved ?? 0), pendingJobs: toCount(count?.jobs ?? 0) }, storage: { liveRows: toCount(storage.rows[0]?.live ?? 0), deadRows: toCount(storage.rows[0]?.dead ?? 0), lastAnalyze: storage.rows[0]?.lastAnalyze ?? null, lastVacuum: storage.rows[0]?.lastVacuum ?? null } },
    worker: { ...worker, latestJob: latestJob ? { id: latestJob.id, status: latestJob.status, totalFeeds: latestJob.totalFeeds, completedFeeds: latestJob.completedFeeds, failedFeeds: latestJob.failedFeeds, createdAt: dateToEpoch(latestJob.createdAt), startedAt: dateToEpoch(latestJob.startedAt), finishedAt: dateToEpoch(latestJob.finishedAt), leaseExpiresAt: dateToEpoch(latestJob.leaseExpiresAt), error: safeError(latestJob.error) } : null },
    feeds: feedRows.map(feed => ({ ...feed, lastError: safeError(feed.lastError) })),
    backup: { status: lastBackupAt === null ? "not_reported" : Date.now() / 1000 - lastBackupAt > 86400 ? "stale" : "recent", lastBackupAt, lastRestoreAt, warningAfterSeconds: 86400, latestMaintenanceSnapshot: latestSnapshot ? { id: latestSnapshot.id, operation: latestSnapshot.operation, createdAt: dateToEpoch(latestSnapshot.createdAt) } : null },
    version: { schema: SCHEMA_VERSION, source: state?.sourceVersion, runtime: process.version, artifact: /^[a-zA-Z0-9._-]{1,100}$/.test(process.env.FEVER_ARTIFACT_ID ?? "") ? process.env.FEVER_ARTIFACT_ID : null },
    installation: { status: state?.status, installedAt: state?.installedAt },
    checkedAt: Math.floor(Date.now() / 1000),
  };
}

import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { assertOwner, verifyOwnerPassword, type OwnerContext } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { installation, owners, maintenanceBackups, maintenanceChallenges, stateOperations } from "@/lib/db/schema";
import { encryptSecret, encryptionKeyId, sha256, tokenHash } from "@/lib/crypto";
import { SCHEMA_VERSION } from "@/lib/config";
import { HttpError } from "@/lib/integrations/http";
import { logEvent } from "@/lib/observability/log";

export type MaintenanceOperation = "empty" | "flush" | "unorphan" | "uninstall";
type Database = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Row = Record<string, unknown>;
interface Snapshot { schemaVersion: number; ownerId: number; operation: MaintenanceOperation; tables: Record<string, Row[]>; }
const operations = new Set<MaintenanceOperation>(["empty", "flush", "unorphan", "uninstall"]);
const maxSnapshotBytes = 64 * 1024 * 1024;
async function assertReady(tx: Transaction, owner: OwnerContext) {
  const [state] = await tx.select({ status: installation.status, authEpoch: owners.authEpoch }).from(installation).innerJoin(owners, eq(owners.id, owner.id)).where(and(eq(installation.id, 1), eq(owners.email, owner.email))).limit(1);
  if (!state || state.status !== "ready") throw new HttpError("This installation is not available for maintenance.", 503, "MAINTENANCE");
  return state;
}
export function maintenanceOperation(value: unknown): MaintenanceOperation {
  if (typeof value !== "string" || !operations.has(value as MaintenanceOperation)) throw new HttpError("Choose a maintenance operation.");
  return value as MaintenanceOperation;
}

const tables = ["installation", "owner", "fever_credentials", "auth_recovery_tokens", "reader_preferences", "reader_view_state", "sharing_services", "favicons", "groups", "feeds", "feed_groups", "feed_credentials", "feed_fetch_state", "items", "item_identity_aliases", "link_occurrences", "blacklist_rules", "refresh_jobs", "job_feed_results", "ingest_quarantine"] as const;
/** The schema is deliberately singleton. No external schemas or user-supplied identifiers occur here. */
async function snapshot(tx: Transaction, owner: OwnerContext, operation: MaintenanceOperation): Promise<Snapshot> {
  if (owner.id !== 1) throw new HttpError("The installation owner is ambiguous.", 409, "OWNER_SCOPE");
  const result: Snapshot = { schemaVersion: SCHEMA_VERSION, ownerId: owner.id, operation, tables: {} };
  let bytes = 0, totalRows = 0;
  for (const table of tables) {
    const order = table === "reader_preferences" ? "owner_id" : table === "reader_view_state" ? "owner_id,device_id" : table === "feed_groups" ? "feed_id,group_id" : table === "item_identity_aliases" ? "feed_id,alias_key" : table === "feed_credentials" || table === "feed_fetch_state" ? "feed_id" : "id";
    const rows = await tx.execute<{ row: Row }>(sql`select to_jsonb(t) as row from ${sql.identifier(table)} as t order by ${sql.raw(order)} limit 100001`);
    totalRows += rows.rows.length;
    if (totalRows > 100_000) throw new HttpError("This installation is too large for browser maintenance. Use the operator backup and maintenance procedure.", 409, "OPERATOR_MAINTENANCE_REQUIRED");
    result.tables[table] = rows.rows.map(row => row.row);
    bytes += Buffer.byteLength(JSON.stringify(result.tables[table]));
    if (bytes > maxSnapshotBytes) throw new HttpError("This installation requires an operator backup before maintenance.", 409, "OPERATOR_MAINTENANCE_REQUIRED");
  }
  return result;
}
function reviewHash(value: Snapshot): string {
  // View timestamps and active job progress must not invalidate an otherwise unchanged preview.
  const affected = ["feeds", "groups", "feed_groups", "items", "item_identity_aliases", "link_occurrences", "favicons"];
  return sha256(JSON.stringify({ operation: value.operation, tables: Object.fromEntries(affected.map(table => [table, value.tables[table]])) }));
}
function consequences(value: Snapshot): Record<string, number> {
  const feeds = new Set(value.tables.feeds.map(row => Number(row.id)));
  const items = new Set(value.tables.items.map(row => Number(row.id)));
  const saved = value.tables.items.filter(row => row.is_saved === true).length;
  const orphanItems = value.tables.items.filter(row => !feeds.has(Number(row.feed_id))).length;
  const orphanLinks = value.tables.link_occurrences.filter(row => !feeds.has(Number(row.feed_id)) || !items.has(Number(row.item_id))).length;
  const all = value.operation === "empty" || value.operation === "uninstall";
  return {
    feeds: all ? value.tables.feeds.length : 0,
    groups: all ? value.tables.groups.length : 0,
    items: all ? value.tables.items.length : value.operation === "flush" ? value.tables.items.length - saved : orphanItems,
    savedItems: all ? saved : value.operation === "unorphan" ? value.tables.items.filter(row => row.is_saved === true && !feeds.has(Number(row.feed_id))).length : 0,
    retainedSavedItems: value.operation === "flush" ? saved : 0,
    links: value.operation === "unorphan" ? orphanLinks : value.tables.link_occurrences.length,
    favicons: value.operation === "unorphan" ? 0 : value.tables.favicons.filter(row => !row.is_default).length,
  };
}
const summaries: Record<MaintenanceOperation, string> = {
  empty: "Remove every subscription, group, article, saved article, and cached link. Keep the owner account and preferences. An encrypted recovery snapshot is retained.",
  flush: "Remove unsaved articles and all Hot links. Keep saved articles, subscriptions, memberships, credentials, and display preferences; reset fetched feed metadata and favicons for refresh. An encrypted recovery snapshot is retained.",
  unorphan: "Remove articles whose feed is missing and links whose feed or article is missing. Healthy data is retained. An encrypted recovery snapshot is retained.",
  uninstall: "Disable this installation, revoke all access, and remove reader data and preferences. Retain the locked installation record, owner identity, audit history, migration evidence, and encrypted recovery snapshot. Application files and external databases are untouched.",
};

export async function previewMaintenance(owner: OwnerContext, payload: Record<string, unknown>) {
  await assertOwner(owner);
  const operation = maintenanceOperation(payload.operation);
  const [proof] = await getDb().select({ authEpoch: owners.authEpoch }).from(owners).where(eq(owners.id, owner.id)).limit(1);
  if (typeof payload.currentPassword !== "string" || !await verifyOwnerPassword(owner, payload.currentPassword)) throw new HttpError("Enter your current password to preview maintenance.", 403, "REAUTHENTICATION_REQUIRED");
  try { encryptSecret("", `maintenance:${owner.id}:${operation}`); }
  catch { throw new HttpError("A recovery encryption key must be configured before maintenance can continue.", 503, "BACKUP_KEY_UNAVAILABLE"); }
  const token = randomBytes(32).toString("base64url");
  return getDb().transaction(async tx => {
    // Exclusive snapshot lock keeps the preview coherent without a stale repeatable-read
    // snapshot acquired while waiting behind an operator maintenance transition.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('fever:installation', 0))`);
    const account = await assertReady(tx, owner);
    if (!proof || proof.authEpoch !== account.authEpoch) throw new HttpError("Your account changed. Enter the current password and preview again.", 409, "REAUTHENTICATION_REQUIRED");
    const value = await snapshot(tx, owner, operation), counts = consequences(value);
    await tx.insert(maintenanceChallenges).values({ ownerId: owner.id, operation, tokenHash: tokenHash(token, "maintenance"), authEpoch: account.authEpoch, snapshotHash: reviewHash(value), counts, expiresAt: new Date(Date.now() + 10 * 60_000) });
    return { token, summary: summaries[operation], counts, confirmation: operation.toUpperCase(), expiresIn: 600 };
  }, { isolationLevel: "read committed" });
}

export async function executeMaintenance(owner: OwnerContext, payload: Record<string, unknown>) {
  await assertOwner(owner);
  const operation = maintenanceOperation(payload.operation);
  if (typeof payload.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.token) || payload.confirmation !== operation.toUpperCase()) throw new HttpError(`Type ${operation.toUpperCase()} to confirm the previewed operation.`, 400, "CONFIRMATION_REQUIRED");
  const result = await getDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('fever:installation', 0))`);
    const [state] = await tx.select().from(installation).where(eq(installation.id, 1)).for("update");
    const [account] = await tx.select().from(owners).where(eq(owners.id, owner.id)).for("update");
    if (!account || state?.status !== "ready") throw new HttpError("This installation is not available for maintenance.", 409, "INSTALLATION_UNAVAILABLE");
    const [challenge] = await tx.select().from(maintenanceChallenges).where(and(eq(maintenanceChallenges.ownerId, owner.id), eq(maintenanceChallenges.tokenHash, tokenHash(payload.token as string, "maintenance")))).for("update");
    if (!challenge || challenge.operation !== operation || challenge.usedAt || challenge.expiresAt.getTime() <= Date.now() || challenge.authEpoch !== account.authEpoch) throw new HttpError("This maintenance preview has expired. Preview it again.", 409, "PREVIEW_EXPIRED");
    const value = await snapshot(tx, owner, operation);
    if (reviewHash(value) !== challenge.snapshotHash) throw new HttpError("The affected data changed after your preview. Preview the operation again.", 409, "PREVIEW_CHANGED");
    const counts = consequences(value), plaintext = JSON.stringify(value), context = `maintenance:${owner.id}:${operation}`;
    const ciphertext = encryptSecret(plaintext, context), snapshotHash = sha256(plaintext), keyId = encryptionKeyId(ciphertext);
    const [backup] = await tx.insert(maintenanceBackups).values({ ownerId: owner.id, operation, ciphertext, keyId, snapshotHash, counts }).returning({ id: maintenanceBackups.id });
    await tx.update(maintenanceChallenges).set({ usedAt: new Date() }).where(eq(maintenanceChallenges.id, challenge.id));
    // Fence in-flight workers before deleting anything; jobs never commit after cancellation.
    await tx.execute(sql`update refresh_jobs set status='cancelled', cancel_requested_at=now(), finished_at=now(), lease_owner=null, lease_expires_at=null, fence=fence+1 where owner_id=${owner.id} and status in ('queued','running')`);
    await tx.execute(sql`update feed_fetch_state set lease_owner=null, lease_expires_at=null, fence=fence+1 where feed_id in (select id from feeds where owner_id=${owner.id})`);
    if (operation === "unorphan") {
      await tx.execute(sql`delete from link_occurrences l where not exists(select 1 from feeds f where f.id=l.feed_id) or not exists(select 1 from items i where i.id=l.item_id and i.feed_id=l.feed_id)`);
      await tx.execute(sql`delete from items i where not exists(select 1 from feeds f where f.id=i.feed_id)`);
    } else if (operation === "flush") {
      await tx.execute(sql`delete from link_occurrences where feed_id in (select id from feeds where owner_id=${owner.id})`);
      await tx.execute(sql`delete from items where not is_saved and feed_id in (select id from feeds where owner_id=${owner.id})`);
      await tx.execute(sql`update items set title=title || ' [SURVIVED FLUSH]', updated_at=extract(epoch from now())::bigint where is_saved and feed_id in (select id from feeds where owner_id=${owner.id})`);
      await tx.execute(sql`update feeds set title='', site_url='', domain='', favicon_id=null, updated_at=now() where owner_id=${owner.id}`);
      await tx.execute(sql`update feed_fetch_state set last_refreshed_at=0, last_success_at=0, next_attempt_at=0, etag=null, last_modified=null, status='pending', last_error=null where feed_id in (select id from feeds where owner_id=${owner.id})`);
      await tx.execute(sql`delete from favicons where owner_id=${owner.id} and not is_default`);
    } else {
      await tx.execute(sql`delete from feeds where owner_id=${owner.id}`);
      await tx.execute(sql`delete from groups where owner_id=${owner.id}`);
      await tx.execute(sql`delete from favicons where owner_id=${owner.id} and not is_default`);
      await tx.execute(sql`update reader_view_state set feed_id=0, group_id=0, version=version+1, updated_at=now() where owner_id=${owner.id}`);
      if (operation === "uninstall") {
        await tx.execute(sql`delete from fever_credentials where owner_id=${owner.id}`);
        await tx.execute(sql`delete from auth_recovery_tokens where owner_id=${owner.id}`);
        await tx.execute(sql`delete from sharing_services where owner_id=${owner.id}`);
        await tx.execute(sql`delete from reader_preferences where owner_id=${owner.id}`);
        await tx.execute(sql`delete from reader_view_state where owner_id=${owner.id}`);
        await tx.execute(sql`delete from blacklist_rules where owner_id=${owner.id}`);
        await tx.execute(sql`delete from favicons where owner_id=${owner.id}`);
        await tx.update(owners).set({ authEpoch: sql`${owners.authEpoch}+1`, recoveryRequired: true, updatedAt: new Date() }).where(eq(owners.id, owner.id));
        await tx.update(installation).set({ status: "uninstalled", setupClosed: true, updatedAt: new Date() }).where(eq(installation.id, 1));
      }
    }
    const [journal] = await tx.insert(stateOperations).values({ ownerId: owner.id, origin: "ui", action: `maintenance.${operation}`, affectedIds: [], before: { maintenanceBackup: { id: backup.id, snapshotHash, keyId, context } }, after: { operation, counts, status: operation === "uninstall" ? "uninstalled" : "ready" } }).returning({ id: stateOperations.id });
    return { operation, counts, backupId: backup.id, operationId: journal.id, signedOut: operation === "uninstall" };
  }, { isolationLevel: "serializable" });
  logEvent("maintenance.completed", { operation, backupId: result.backupId, operationId: result.operationId, counts: result.counts });
  return result;
}

export async function clearFavicons(owner: OwnerContext) {
  await assertOwner(owner);
  return getDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('fever:installation',0))`);
    await assertReady(tx, owner);
    const before = await tx.execute<{ row: Row }>(sql`select to_jsonb(t) as row from favicons t where owner_id=${owner.id} and not is_default`);
    const feedsBefore = await tx.execute<{ row: Row }>(sql`select to_jsonb(t) as row from feeds t where owner_id=${owner.id}`);
    const fetchBefore = await tx.execute<{ row: Row }>(sql`select to_jsonb(t) as row from feed_fetch_state t where feed_id in (select id from feeds where owner_id=${owner.id})`);
    await tx.execute(sql`update feeds set favicon_id=null where owner_id=${owner.id}`);
    await tx.execute(sql`delete from favicons where owner_id=${owner.id} and not is_default`);
    await tx.execute(sql`update feed_fetch_state set last_refreshed_at=0,next_attempt_at=0 where feed_id in (select id from feeds where owner_id=${owner.id})`);
    const feedsAfter = await tx.execute<{ row: Row }>(sql`select to_jsonb(t) as row from feeds t where owner_id=${owner.id}`);
    const fetchAfter = await tx.execute<{ row: Row }>(sql`select to_jsonb(t) as row from feed_fetch_state t where feed_id in (select id from feeds where owner_id=${owner.id})`);
    const [journal] = await tx.insert(stateOperations).values({ ownerId: owner.id, origin: "ui", action: "favicons.clear", affectedIds: before.rows.map(row => Number(row.row.id)), before: { favicons: before.rows.map(row => row.row), feeds: feedsBefore.rows.map(row => row.row), feedFetchState: fetchBefore.rows.map(row => row.row) }, after: { favicons: [], feeds: feedsAfter.rows.map(row => row.row), feedFetchState: fetchAfter.rows.map(row => row.row) } }).returning({ id: stateOperations.id });
    return { cleared: before.rows.length, operationId: journal.id };
  });
}

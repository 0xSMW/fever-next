import type { Client } from "pg";
import { createHash } from "node:crypto";
import { SCHEMA_VERSION, validateBaseUrl } from "../config";
import { decryptSecret, encryptSecret, encryptionKeyId, sha256 } from "../crypto";
import { hashPassword, verifyPassword } from "../auth/password";
import { feverDigestVerifier } from "../auth/fever";
import { defaultFaviconRecord } from "../auth/default-favicon";
import { normalizeLoginEmail } from "../auth/security";
import { normalizeUrl } from "../legacy-url";
import { plainText, sanitizeContent, SANITIZER_VERSION } from "../ingest/content";
import { analyzeSnapshot, dispositionKey, mapRow, type Analysis } from "./analyze";
import { assertSchema, assertTarget, insertRecord, lockTarget, reconcileSequences, snakeObject } from "./target";
import { digest, snapshotRows, stableJson } from "./snapshot";
import { text, type MappedRow } from "./transform";
import { utf8 } from "./php";
import type { Snapshot, SnapshotRow } from "./types";

interface TargetRecord { table: string; values: Record<string, unknown>; key: string[]; }
function targetRecord(table: string, values: Record<string, unknown>, key = ["id"]): TargetRecord { return { table, values, key }; }
function display(value: { itemExcerpts: number; itemAllows: number; unreadCounts: number; sortOrder: number }) { return { item_excerpts: value.itemExcerpts, item_allows: value.itemAllows, unread_counts: value.unreadCounts, sort_order: value.sortOrder }; }
export async function targetRecords(value: MappedRow, row: SnapshotRow, shareProtected: boolean): Promise<TargetRecord[]> {
  if (value.kind === "config") {
    const { services, ...preferences } = value.preferences;
    return [
      targetRecord("owner", { id: 1, email: value.email, email_key: normalizeLoginEmail(value.email), password_hash: await hashPassword(value.password) }),
      targetRecord("fever_credentials", { owner_id: 1, verifier: feverDigestVerifier(value.emailBytes, value.password), source: "legacy-import" }, ["owner_id"]),
      targetRecord("reader_preferences", { owner_id: 1, ...snakeObject(preferences), share_protected: shareProtected }, ["owner_id"]),
      targetRecord("reader_view_state", { owner_id: 1, device_id: "default", ...snakeObject(value.view), last_viewed_at: value.lastViewedAt, last_session_at: value.lastSessionAt }, ["owner_id", "device_id"]),
      ...services.map((service, position) => targetRecord("sharing_services", { owner_id: 1, position, name: service.name, url: service.url.replace(/^#/, ""), original_url: service.url, key: service.key, enabled: service.enabled !== false, reason: service.reason ?? null, transport: service.enabled === false ? "disabled" : service.url.startsWith("#") ? "background" : "navigate" }, ["owner_id", "position"])),
      ...(row.table === "User" ? [targetRecord("favicons", snakeObject(defaultFaviconRecord(1, 0)))] : []),
    ];
  }
  if (value.kind === "group") return [targetRecord("groups", { id: value.id, owner_id: 1, title: value.title, ...display(value) })];
  if (value.kind === "favicon") return [targetRecord("favicons", { id: value.id, owner_id: 1, url: value.url, url_key: sha256(normalizeUrl(value.url)), url_checksum: value.checksum, mime_type: value.mime, data: value.data, content_hash: sha256(value.data), cached_at: value.cachedAt, is_default: value.id === 1 })];
  if (value.kind === "feed") {
    const result = [targetRecord("feeds", { id: value.id, owner_id: 1, url: value.url, original_url: value.url, canonical_url: normalizeUrl(value.url), url_key: sha256(normalizeUrl(value.url)), url_checksum: value.checksum, title: value.title ?? "", site_url: value.siteUrl ?? "", domain: value.domain ?? "", favicon_id: value.faviconId || null, requires_auth: value.requiresAuth, is_spark: value.isSpark, prevents_hotlinking: value.preventsHotlinking, ...display(value) }),
      targetRecord("feed_fetch_state", { feed_id: value.id, last_refreshed_at: value.lastRefreshedAt, last_updated_at: value.lastUpdatedAt, last_added_at: value.lastAddedAt }, ["feed_id"])];
    if (value.credential) {
      const credential = utf8(value.credential); const split = credential.indexOf(":");
      const ciphertext = encryptSecret(JSON.stringify({ username: credential.slice(0, split), password: credential.slice(split + 1) }), `feed:${value.id}`);
      result.push(targetRecord("feed_credentials", { feed_id: value.id, ciphertext, key_id: encryptionKeyId(ciphertext) }, ["feed_id"]));
    }
    if (row.table === "Feed" && row.fields.groupId) result.push(targetRecord("feed_groups", { feed_id: value.id, group_id: Number(text(row, "groupId")) }, ["feed_id", "group_id"]));
    return result;
  }
  if (value.kind === "membership") return [targetRecord("feed_groups", { feed_id: value.feedId, group_id: value.groupId }, ["feed_id", "group_id"])];
  if (value.kind === "item") {
    const uid = value.uid || `legacy-row:${value.id}`; const rawHtml = value.rawHtml ?? ""; const url = value.url ?? "";
    const result = [targetRecord("items", { id: value.id, feed_id: value.feedId, raw_uid: value.uid ?? "", legacy_uid: value.uid, identity_key: sha256(`${value.uid ? "uid" : "legacy-row"}:v1:${uid}`), title: value.title ?? "", author: value.author ?? "", raw_html: rawHtml, html: sanitizeContent(rawHtml, "rich", url || undefined), search_text: [value.title, value.author, plainText(rawHtml)].filter(Boolean).join(" "), sanitizer_version: SANITIZER_VERSION, url, canonical_url: normalizeUrl(url), url_key: url ? sha256(normalizeUrl(url)) : null, url_checksum: value.checksum, published_at: value.publishedAt, added_at: value.addedAt, read_at: value.readAt, is_saved: value.isSaved, content_hash: sha256(rawHtml), source_fingerprint: digest(row) })];
    if (value.uid) result.push(targetRecord("item_identity_aliases", { feed_id: value.feedId, alias_key: sha256(`legacy_uid:${value.uid}`), alias: value.uid, kind: "legacy_uid", item_id: value.id }, ["feed_id", "alias_key"]));
    return result;
  }
  if (value.kind === "link") return [targetRecord("link_occurrences", { id: value.id, feed_id: value.feedId, item_id: value.itemId, url: value.url ?? "", original_url: value.url ?? "", canonical_url: normalizeUrl(value.url ?? ""), url_key: sha256(normalizeUrl(value.url ?? "")), title: value.title ?? "", url_checksum: value.checksum, title_url_checksum: value.titleChecksum, created_at: value.createdAt, is_item: value.isItem, is_local: value.isLocal, is_first: value.isFirst, is_blacklisted: value.isBlacklisted, weight: value.weight })];
  throw new Error("Unknown mapped row kind");
}
function comparable(value: unknown): string {
  if (Buffer.isBuffer(value)) return `bytes:${value.toString("base64")}`;
  if (value === null) return "null";
  if (typeof value === "object") return stableJson(value);
  return String(value);
}
async function insertAndVerify(client: Client, record: TargetRecord) {
  await insertRecord(client, record.table, record.values);
  const columns = Object.keys(record.values);
  const read = await client.query(`SELECT ${columns.map(key => `"${key}"`).join(",")} FROM "${record.table}" WHERE ${record.key.map((key, index) => `"${key}"=$${index + 1}`).join(" AND ")}`, record.key.map(key => record.values[key]));
  if (read.rowCount !== 1 || columns.some(key => comparable(read.rows[0][key]) !== comparable(record.values[key]))) throw new Error(`Target field conservation failed for ${record.table}`);
}
async function verifyImportedFields(client: Client, snapshot: Snapshot, analysis: Analysis, shareProtected: boolean): Promise<string> {
  const hash = createHash("sha256");
  for await (const row of snapshotRows(snapshot)) {
    if (analysis.dispositions.get(dispositionKey(row))?.disposition !== "import") continue;
    const mapped = mapRow(snapshot, row);
    for (const record of await targetRecords(mapped, row, shareProtected)) {
      const columns = Object.keys(record.values);
      const read = await client.query(`SELECT ${columns.map(key => `"${key}"`).join(",")} FROM "${record.table}" WHERE ${record.key.map((key, index) => `"${key}"=$${index + 1}`).join(" AND ")}`, record.key.map(key => record.values[key]));
      if (read.rowCount !== 1) throw new Error("Final target entity conservation failed");
      const actual = read.rows[0];
      for (const column of columns) {
        if (record.table === "owner" && column === "password_hash" && mapped.kind === "config") {
          if (!await verifyPassword(mapped.password, actual[column])) throw new Error("Imported password verification failed");
        } else if (record.table === "feed_credentials" && column === "ciphertext") {
          const context = `feed:${record.values.feed_id}`;
          if (decryptSecret(actual[column], context) !== decryptSecret(String(record.values[column]), context)) throw new Error("Imported feed credential verification failed");
        } else if (comparable(actual[column]) !== comparable(record.values[column])) throw new Error(`Final field conservation failed for ${record.table}`);
      }
      // Only a digest of the verified field set is persisted; plaintext secrets are excluded.
      hash.update(stableJson({ sourceRow: digest(row), targetTable: record.table, keys: record.key.map(key => record.values[key]), columns }) + "\n");
    }
  }
  return hash.digest("hex");
}
export interface ImportOptions { targetUrl: string; targetFingerprint: string; sourceFingerprint: string; baseUrl: string; allowQuarantine?: string; savedRssPolicy?: "legacy" | "exclude-protected"; batchSize?: number; }
export async function importSnapshot(client: Client, snapshot: Snapshot, options: ImportOptions, priorAnalysis?: Analysis) {
  if (snapshot.footer.fingerprint !== options.sourceFingerprint) throw new Error("Explicit source fingerprint does not match the snapshot");
  const baseUrl = validateBaseUrl(options.baseUrl); if (!baseUrl) throw new Error("Canonical base URL is required");
  const analysis = priorAnalysis ?? await analyzeSnapshot(snapshot);
  if (!analysis.config || !analysis.report.conservation) throw new Error("An importable owner and complete conservation report are required");
  if (analysis.report.issues.some(issue => issue.code === "MISSING_DEFAULT_FAVICON")) throw new Error("Legacy default favicon ID1 must be reconciled before import");
  if (!analysis.report.readyToImport && options.allowQuarantine !== snapshot.footer.fingerprint) throw new Error("Blocking source issues require review and explicit fingerprint-bound quarantine acceptance");
  if (analysis.config.preferences.share && !options.savedRssPolicy) throw new Error("Imported Saved RSS publication requires an explicit legacy or exclude-protected policy");
  const shareProtected = options.savedRssPolicy === "legacy";
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("Import batch must contain 1–500 source rows");
  await assertTarget(client, options.targetUrl, options.targetFingerprint); await lockTarget(client); await assertSchema(client);
  const existing = await client.query("SELECT * FROM migration_runs ORDER BY id");
  let run = existing.rows.find(entry => entry.source_fingerprint === snapshot.footer.fingerprint && entry.target_fingerprint === options.targetFingerprint);
  if (existing.rows.length && (!run || existing.rows.length !== 1)) throw new Error("Target belongs to another import; choose a separate empty destination");
  const keyContext = `migration:${snapshot.footer.fingerprint}`;
  if (run) {
    if (run.policy_version !== 1 || run.schema_version !== SCHEMA_VERSION || run.manifest.baseUrl !== baseUrl || run.manifest.shareProtected !== shareProtected) throw new Error("Resume policy differs from the original import");
    if (decryptSecret(run.manifest.keyCheck, keyContext) !== snapshot.footer.fingerprint) throw new Error("Import encryption key continuity failed");
    if (run.status === "completed") return { runId: run.id, status: "already-completed", report: analysis.report };
  } else {
    const installation = (await client.query("SELECT status,setup_closed FROM installation WHERE id=1")).rows[0];
    if (installation.status !== "uninitialized" || installation.setup_closed) throw new Error("A new import requires an untouched uninitialized destination");
    for (const table of ["owner", "feeds", "groups", "favicons", "items", "link_occurrences", "state_operations", "maintenance_backups", "ingest_quarantine", "auth_rate_limits", "auth_recovery_tokens", "refresh_jobs", "worker_heartbeats"]) {
      if ((await client.query(`SELECT EXISTS(SELECT 1 FROM "${table}") AS populated`)).rows[0].populated) throw new Error("Import destination is not empty");
    }
    const keyCheck = encryptSecret(snapshot.footer.fingerprint, keyContext);
    await client.query("BEGIN");
    try {
      await client.query("UPDATE installation SET status='maintenance',setup_closed=true,base_url=$1,source_version=$2,installed_at=$3,migration_provenance=$4 WHERE id=1", [baseUrl, analysis.report.sourceVersion, analysis.config.installedAt, JSON.stringify({ sourceFingerprint: snapshot.footer.fingerprint, policyVersion: 1 })]);
      const result = await client.query("INSERT INTO migration_runs(source_kind,source_fingerprint,target_fingerprint,schema_version,policy_version,status,manifest) VALUES($1,$2,$3,$4,1,'running',$5) RETURNING *", [snapshot.header.source, snapshot.footer.fingerprint, options.targetFingerprint, SCHEMA_VERSION, JSON.stringify({ header: snapshot.header, footer: snapshot.footer, baseUrl, shareProtected, keyCheck, frozenAt: analysis.report.frozenAt, snapshotFileDigest: digest(snapshot.footer) })]);
      run = result.rows[0]; await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  const installation = await client.query("SELECT status FROM installation WHERE id=1");
  if (installation.rows[0]?.status !== "maintenance") throw new Error("Import requires the target write freeze (maintenance status)");
  const checkpoints: Record<string, number> = { ...run.checkpoints };
  const buffered: SnapshotRow[] = [];
  const commitBatch = async () => {
    if (!buffered.length) return;
    await client.query("BEGIN");
    try {
      for (const row of buffered) {
        const disposition = analysis.dispositions.get(dispositionKey(row));
        if (!disposition || disposition.digest !== digest(row)) throw new Error("Source changed during import");
        if (disposition.disposition === "import") for (const record of await targetRecords(mapRow(snapshot, row), row, shareProtected)) await insertAndVerify(client, record);
        const rowIssues = analysis.report.issues.filter(issue => issue.table === row.table && issue.ordinal === row.ordinal);
        // Original bytes are encrypted for every row: NULLs, unknown fields, and
        // credential bytes remain recoverable without a lossy reverse inference.
        const context = `migration-row:${run.id}:${row.table}:${row.ordinal}`;
        const ciphertext = encryptSecret(stableJson(row), context);
        await insertRecord(client, "migration_issues", { run_id: run.id, source_table: row.table, source_id: String(row.ordinal), code: "SOURCE_ARCHIVE", severity: "info", message: "Restricted original row and field disposition", details: JSON.stringify({ context, disposition, issues: rowIssues }), raw_data: Buffer.from(ciphertext, "utf8"), raw_data_hash: digest(row), encrypted: true, key_id: encryptionKeyId(ciphertext), disposition: disposition.disposition === "quarantine" ? "quarantined" : "archived" });
        checkpoints[row.table] = row.ordinal;
      }
      await client.query("UPDATE migration_runs SET checkpoints=$1,stage=$2,counts=$3,updated_at=now() WHERE id=$4", [JSON.stringify(checkpoints), buffered[buffered.length - 1].table, JSON.stringify(analysis.report.counts), run.id]);
      await client.query("COMMIT"); buffered.length = 0;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  };
  for await (const row of snapshotRows(snapshot)) {
    if (row.ordinal <= (checkpoints[row.table] ?? 0)) continue;
    buffered.push(row); if (buffered.length >= batchSize) await commitBatch();
  }
  await commitBatch();
  const reconciledFieldDigest = await verifyImportedFields(client, snapshot, analysis, shareProtected);
  const reservations = Object.fromEntries(Object.entries({ groups: "groups", favicons: "favicons", feeds: "feeds", items: "items", links: "link_occurrences", Group: "groups", Feed: "feeds", Item: "items" }).filter(([source]) => snapshot.footer.tables[source]).map(([source, target]) => [target, snapshot.footer.tables[source].maxId]));
  const sequenceState = await reconcileSequences(client, reservations);
  const state = (await client.query("SELECT count(*) FILTER(WHERE read_at>0)::text AS read,count(*) FILTER(WHERE read_at=0)::text AS unread,count(*) FILTER(WHERE is_saved)::text AS saved FROM items")).rows[0];
  for (const key of ["read", "unread", "saved"] as const) if (Number(state[key]) !== analysis.report.state[key]) throw new Error(`Target ${key} count does not reconcile`);
  const joins = await client.query("SELECT count(*)::text AS count FROM feed_groups");
  if (Number(joins.rows[0].count) !== analysis.report.state.memberships) throw new Error("Target memberships do not reconcile");
  const archiveCount = await client.query("SELECT count(*)::text AS count FROM migration_issues WHERE run_id=$1 AND code='SOURCE_ARCHIVE'", [run.id]);
  if (Number(archiveCount.rows[0].count) !== analysis.dispositions.size) throw new Error("Source row archive conservation failed");
  for (const table of ["feeds", "items", "link_occurrences", "feed_groups"]) await client.query(`ANALYZE "${table}"`);
  await client.query("UPDATE migration_runs SET status='completed',stage='reconciled',completed_at=now(),updated_at=now(),manifest=manifest || $1::jsonb WHERE id=$2", [JSON.stringify({ sequenceState, reconciledFieldDigest, report: analysis.report, activationRequired: true, idPolicy: "preserved-original-ids-single-source-namespace" }), run.id]);
  return { runId: run.id, status: "completed-in-maintenance", report: analysis.report, sequenceState };
}

import type { Client } from "pg";
import { readFile } from "node:fs/promises";
import { decryptSecret } from "../crypto";
import { verifyPassword } from "../auth/password";
import { feverDigestVerifier } from "../auth/fever";
import { inputFile, writeRestrictedJson } from "./files";
import { decodePhp, encodePhp, phpArray, phpObject, strictBase64, utf8, type PhpValue } from "./php";
import { digest, extractSnapshot, snapshotRows } from "./snapshot";
import { mysqlSource } from "./sources";
import { LEGACY_TABLES, type Cell, type Snapshot, type SnapshotRow, type SourceAdapter, type SourceTable } from "./types";

type Fields = Record<string, Cell>;
type RowIndex = Map<string, Map<string, Fields>>;
const rowKey = (table: string, fields: Fields) => table === "feeds_groups" ? digest(fields) : fields.id ? utf8(strictBase64(fields.id.base64)) : "missing-id";
const cell = (value: unknown): Cell => value === null || value === undefined ? null : { base64: Buffer.isBuffer(value) ? value.toString("base64") : Buffer.from(typeof value === "boolean" ? value ? "1" : "0" : String(value), "utf8").toString("base64") };
async function indexSnapshot(snapshot: Snapshot): Promise<RowIndex> {
  const result: RowIndex = new Map(); let totalBytes = 0;
  for (const table of LEGACY_TABLES) result.set(table, new Map());
  for await (const row of snapshotRows(snapshot)) {
    totalBytes += JSON.stringify(row).length;
    if (totalBytes > 512 * 1024 * 1024) throw new Error("Rollback bundle exceeds the bounded in-memory review limit; partitioned replay requires a separately reviewed implementation");
    const rows = result.get(row.table); if (!rows) throw new Error("Rollback requires a legacy MySQL source snapshot");
    const key = rowKey(row.table, row.fields);
    if (row.table === "feeds_groups") rows.set(`${key}:${row.ordinal}`, row.fields); else if (rows.has(key)) throw new Error("Duplicate source IDs prevent rollback mapping"); else rows.set(key, row.fields);
  }
  return result;
}
async function* pgRows(client: Client, table: string, order = "id"): AsyncGenerator<Record<string, unknown>> {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_, ]+$/.test(order)) throw new Error("Invalid internal rollback table");
  for (let offset = 0; ; offset += 250) {
    const result = await client.query(`SELECT * FROM "${table}" ORDER BY ${order} LIMIT 250 OFFSET $1`, [offset]);
    for (const row of result.rows) yield row;
    if (result.rowCount! < 250) return;
  }
}
const preferenceKeys = ["use_celsius", "refresh_interval", "item_expiration", "new_window", "unread_counts", "layout", "item_excerpts", "item_allows", "sort_order", "auto_spark", "per_page", "auto_read", "mobile_read_on_scroll", "mobile_read_on_back_out", "mobile_view_in_app", "auto_reload", "auto_refresh", "auto_update", "toggle_click", "anonymize", "session_timeout", "blacklist", "share"];
const viewSections = { hot: 0, kindling: 1, saved: 2, sparks: 3, search: 4 };
function phpScalar(value: unknown): PhpValue { if (typeof value === "boolean") return value; if (typeof value === "number") return value; if (value === null) return null; return Buffer.from(String(value)); }
function validateLegacyShape(table: string, fields: Fields) {
  const varchar = new Set(table === "feeds" ? ["title", "url", "site_url", "domain", "auth"] : table === "items" ? ["uid", "title", "author", "link"] : table === "groups" ? ["title"] : table === "links" ? ["title", "url"] : table === "favicons" ? ["url"] : []);
  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue;
    const bytes = strictBase64(value.base64);
    if (varchar.has(key) && Array.from(utf8(bytes)).length > 255) throw new Error("A target field exceeds the legacy varchar(255) boundary; explicit reconciliation is required before rollback");
    if (["id", "feed_id", "group_id", "favicon_id", "item_id", "url_checksum", "title_url_checksum", "weight", "read_on_time", "created_on_time", "added_on_time", "last_refreshed_on_time", "last_updated_on_time", "last_added_on_time", "last_cached_on_time"].includes(key) && (!/^\d+$/.test(bytes.toString("ascii")) || BigInt(bytes.toString("ascii")) > 4_294_967_295n)) throw new Error("A target identifier, checksum, or time exceeds the legacy unsigned range");
    if (["description", "cache"].includes(key) && bytes.length > 65_535) throw new Error("A target content field exceeds legacy TEXT storage; explicit reconciliation is required before rollback");
  }
}
export interface ReplayManifest { format: 1; baselineFingerprint: string; finalFingerprint: string; targetFingerprint: string; journalDigest: string; journalRows: number; exportedAt: string; credentialVerified: boolean; sourceTables: Record<string, number>; }
export async function exportLegacyRollback(client: Client, baseline: Snapshot, output: string, targetFingerprint: string, options: { passwordFile?: string; disableSavedRss?: boolean } = {}): Promise<ReplayManifest> {
  if (baseline.header.source !== "mysql") throw new Error("PHP rollback requires a retained MySQL snapshot");
  const old = await indexSnapshot(baseline);
  const configRow = old.get("_config")?.get("1");
  if (!configRow?.cfg || !configRow.prefs) throw new Error("Retained legacy configuration is unavailable");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const installation = (await client.query("SELECT * FROM installation WHERE id=1")).rows[0];
    if (installation?.status !== "maintenance") throw new Error("Freeze web and worker writes before exporting rollback activity");
    const run = (await client.query("SELECT * FROM migration_runs WHERE source_fingerprint=$1 AND status='completed'", [baseline.footer.fingerprint])).rows[0];
    if (!run) throw new Error("Baseline does not identify a completed import in this target");
    const owner = (await client.query("SELECT * FROM owner WHERE id=1")).rows[0];
    if (!owner) throw new Error("Owner was uninstalled; restore the maintenance backup or explicitly reconcile before PHP rollback");
    const cfg = phpObject(decodePhp(strictBase64(configRow.cfg.base64)));
    const prefs = phpObject(decodePhp(strictBase64(configRow.prefs.base64)));
    let password = options.passwordFile ? await readFile(await inputFile(options.passwordFile)) : cfg.password;
    if (!Buffer.isBuffer(password) || !await verifyPassword(password, owner.password_hash)) throw new Error("Current target password cannot be reconstructed; provide its exact bytes in an explicitly selected private password file");
    const credential = (await client.query("SELECT verifier FROM fever_credentials WHERE owner_id=1 AND revoked_at IS NULL")).rows[0];
    if (!credential || feverDigestVerifier(Buffer.from(owner.email), password) !== credential.verifier) throw new Error("Current password does not reconcile the active API credential");
    cfg.email = Buffer.from(owner.email); cfg.password = password; cfg.version = 139;
    const preferences = (await client.query("SELECT * FROM reader_preferences WHERE owner_id=1")).rows[0];
    if (preferences.share && !preferences.share_protected && (await client.query("SELECT EXISTS(SELECT 1 FROM items i JOIN feeds f ON f.id=i.feed_id WHERE i.is_saved AND f.requires_auth) AS found")).rows[0].found && !options.disableSavedRss) throw new Error("PHP cannot enforce protected-feed RSS exclusion; explicitly disable Saved RSS or reconcile publication before rollback");
    for (const key of preferenceKeys) prefs[key] = phpScalar(preferences[key]);
    if (options.disableSavedRss) prefs.share = false;
    const services = (await client.query("SELECT * FROM sharing_services WHERE owner_id=1 ORDER BY position")).rows;
    prefs.services = { kind: "array", entries: services.map((service, index) => [index, phpArray({ name: Buffer.from(service.name), url: Buffer.from(service.original_url), key: Buffer.from(service.key) })]) };
    const view = (await client.query("SELECT * FROM reader_view_state WHERE owner_id=1 AND device_id='default'")).rows[0];
    if (view) {
      const ui = prefs.ui ? phpObject(prefs.ui) : {};
      for (const key of ["group_id", "feed_id", "search", "has_focus", "show_feeds", "show_read", "hot_start", "hot_range"]) ui[key] = phpScalar(view[key]);
      ui.section = viewSections[view.section as keyof typeof viewSections]; ui.previous = viewSections[view.previous as keyof typeof viewSections];
      prefs.ui = phpArray(ui); cfg.last_viewed_on_time = Number(view.last_viewed_at); cfg.last_session_on_time = Number(view.last_session_at);
    }
    // Enforce the activity budget before transferring/materializing whole rows.
    // PostgreSQL JSON text also includes spacing, and the per-row allowance covers
    // timestamp serialization and array separators in the Node representation.
    const auditSize = (await client.query(`SELECT COALESCE(SUM(bytes),0)::text AS bytes FROM (
      SELECT octet_length(to_jsonb(entry)::text)::bigint+128 AS bytes FROM state_operations entry WHERE created_at >= $1
      UNION ALL
      SELECT octet_length(to_jsonb(entry)::text)::bigint+128 AS bytes FROM maintenance_backups entry WHERE created_at >= $1
    ) activity`, [run.created_at])).rows[0];
    if (BigInt(auditSize.bytes) + 4096n > 512n * 1024n * 1024n) throw new Error("Rollback activity exceeds the bounded review limit");
    const journal = (await client.query("SELECT * FROM state_operations WHERE created_at >= $1 ORDER BY id", [run.created_at])).rows;
    // Preserve all heterogeneous event envelopes unchanged alongside a frozen final
    // state. This avoids treating partial state mutations as complete entity rows.
    const maintenance = (await client.query("SELECT * FROM maintenance_backups WHERE created_at >= $1 ORDER BY id", [run.created_at])).rows;
    const audit = { journal, maintenance, baselineFingerprint: baseline.footer.fingerprint, targetFingerprint };
    if (Buffer.byteLength(JSON.stringify(audit), "utf8") > 512 * 1024 * 1024) throw new Error("Rollback activity exceeds the bounded review limit");
    await writeRestrictedJson(`${output}.activity.json`, audit);
    const quarantined = new Map<string, Fields[]>();
    const quarantineArchive = await client.query("SELECT raw_data,raw_data_hash,details FROM migration_issues WHERE run_id=$1 AND code='SOURCE_ARCHIVE' AND disposition='quarantined' ORDER BY id", [run.id]);
    for (const record of quarantineArchive.rows) {
      const original = JSON.parse(decryptSecret((record.raw_data as Buffer).toString("utf8"), record.details.context)) as SnapshotRow;
      if (digest(original) !== record.raw_data_hash) throw new Error("Quarantine archive integrity failed");
      const rows = quarantined.get(original.table) ?? []; rows.push(original.fields); quarantined.set(original.table, rows);
    }
    const sourceTables: Record<string, number> = {};
    const make = (table: SourceTable, values: Record<string, unknown>): Fields => {
      const id = String(values.id ?? ""); const before = old.get(table)?.get(id);
      const result: Fields = { ...(before ?? {}) };
      for (const [key, value] of Object.entries(values)) {
        // Source NULL converted to an empty display string is preserved exactly.
        result[key] = before?.[key] === null && value === "" ? null : cell(value);
      }
      const columns = baseline.footer.tables[table].columns;
      if (columns.some(key => !Object.hasOwn(result, key))) throw new Error("New target row cannot fill an unknown legacy column; explicit mapping is required");
      validateLegacyShape(table, result); return result;
    };
    const adapter: SourceAdapter = {
      header: { ...baseline.header, createdAt: new Date().toISOString(), freeze: { acknowledged: true, at: new Date().toISOString(), evidence: `Frozen PostgreSQL reverse export of ${baseline.footer.fingerprint}; target ${targetFingerprint}` } }, tables: LEGACY_TABLES,
      async columns(table) { return baseline.footer.tables[table].columns; },
      async *rows(table) {
        let count = 0;
        const emit = (value: Fields) => { count++; return value; };
        if (table === "_config") yield emit(make(table, { id: 1, cfg: encodePhp(phpArray(cfg)).toString("base64"), prefs: encodePhp(phpArray(prefs)).toString("base64") }));
        if (table === "groups") for await (const row of pgRows(client, "groups")) yield emit(make(table, { id: row.id, title: row.title, item_excerpts: row.item_excerpts, item_allows: row.item_allows, unread_counts: row.unread_counts, sort_order: row.sort_order }));
        if (table === "favicons") for await (const row of pgRows(client, "favicons")) yield emit(make(table, { id: row.id, cache: `${row.mime_type};base64,${(row.data as Buffer).toString("base64")}`, url: row.url, url_checksum: row.url_checksum, last_cached_on_time: row.cached_at }));
        if (table === "feeds") for await (const row of pgRows(client, "feeds")) {
          const fetch = (await client.query("SELECT * FROM feed_fetch_state WHERE feed_id=$1", [row.id])).rows[0];
          const encrypted = (await client.query("SELECT * FROM feed_credentials WHERE feed_id=$1", [row.id])).rows[0];
          let auth = null;
          if (encrypted) { const secret = JSON.parse(decryptSecret(encrypted.ciphertext, `feed:${row.id}`)); auth = Buffer.from(`${secret.username}:${secret.password}`).toString("base64"); }
          yield emit(make(table, { id: row.id, favicon_id: row.favicon_id ?? 0, title: row.title, url: row.url, url_checksum: row.url_checksum, site_url: row.site_url, domain: row.domain, requires_auth: row.requires_auth, auth, is_spark: row.is_spark, prevents_hotlinking: row.prevents_hotlinking, item_excerpts: row.item_excerpts, item_allows: row.item_allows, unread_counts: row.unread_counts, sort_order: row.sort_order, last_refreshed_on_time: fetch?.last_refreshed_at ?? 0, last_updated_on_time: fetch?.last_updated_at ?? 0, last_added_on_time: fetch?.last_added_at ?? 0 }));
        }
        if (table === "feeds_groups") for await (const row of pgRows(client, "feed_groups", "feed_id, group_id")) yield emit(make(table, { feed_id: row.feed_id, group_id: row.group_id }));
        if (table === "items") for await (const row of pgRows(client, "items")) yield emit(make(table, { id: row.id, feed_id: row.feed_id, uid: row.legacy_uid ?? row.raw_uid, title: row.title, author: row.author, description: row.raw_html, link: row.url, url_checksum: row.url_checksum, read_on_time: row.read_at, is_saved: row.is_saved, created_on_time: row.published_at, added_on_time: row.added_at }));
        if (table === "links") for await (const row of pgRows(client, "link_occurrences")) yield emit(make(table, { id: row.id, feed_id: row.feed_id, item_id: row.item_id, is_blacklisted: row.is_blacklisted, is_item: row.is_item, is_local: row.is_local, is_first: row.is_first, title: row.title, url: row.original_url || row.url, url_checksum: row.url_checksum, title_url_checksum: row.title_url_checksum, weight: row.weight, created_on_time: row.created_at }));
        // Quarantined source entities never disappeared: preserve them unchanged in
        // the legacy rollback image, including their originally invalid bytes.
        for (const fields of quarantined.get(table) ?? []) yield emit(fields);
        sourceTables[table] = count;
      }, async close() { /* The outer transaction owns this connection. */ },
    };
    const footer = await extractSnapshot(adapter, output);
    const manifest: ReplayManifest = { format: 1, baselineFingerprint: baseline.footer.fingerprint, finalFingerprint: footer.fingerprint, targetFingerprint, journalDigest: digest(audit), journalRows: journal.length, exportedAt: new Date().toISOString(), credentialVerified: true, sourceTables };
    await writeRestrictedJson(`${output}.manifest.json`, manifest);
    await client.query("COMMIT"); password = Buffer.alloc(0); return manifest;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

/** Apply only a generated, reviewed neutral replay to an offline restored MySQL copy. */
export async function applyLegacyRollback(url: string, prefix: string, baseline: Snapshot, desired: Snapshot, confirmedFingerprint: string, freeze: { acknowledged: true; at: string; evidence: string }) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix) || baseline.header.source !== "mysql" || desired.header.source !== "mysql") throw new Error("Rollback requires an explicit MySQL target and compatible snapshots");
  const original = await indexSnapshot(baseline); const final = await indexSnapshot(desired);
  const reader = await mysqlSource(url, prefix, freeze);
  const endpoint = new URL(url);
  const fingerprint = digest({ host: endpoint.hostname, port: endpoint.port || "3306", database: reader.header.metadata.database, prefix, version: reader.header.metadata.version });
  if (fingerprint !== confirmedFingerprint) { await reader.close(); throw new Error("Rollback target fingerprint does not match"); }
  const present: RowIndex = new Map();
  try {
    for (const table of LEGACY_TABLES) {
      const rows = new Map<string, Fields>(); let ordinal = 0;
      for await (const fields of reader.rows(table)) {
        const key = rowKey(table, fields); ordinal++;
        if (table !== "feeds_groups") {
          const source = original.get(table)?.get(key); const target = final.get(table)?.get(key);
          if ((!source || digest(fields) !== digest(source)) && (!target || digest(fields) !== digest(target))) throw new Error("Restored MySQL row differs from both the frozen baseline and the reviewed final replay; aborting");
          rows.set(key, fields);
        } else rows.set(`${key}:${ordinal}`, fields);
      }
      present.set(table, rows);
    }
  } finally { await reader.close(); }
  const pairs = new Map<string, Fields>();
  for (const index of [original, final]) for (const fields of index.get("feeds_groups")!.values()) pairs.set(digest(fields), fields);
  for (const fields of present.get("feeds_groups")!.values()) if (!pairs.has(digest(fields))) throw new Error("Unexpected relationship in restored MySQL target");
  for (const table of ["feeds", "favicons"]) {
    const checksums = new Set<string>();
    for (const fields of final.get(table)!.values()) {
      const checksum = fields.url_checksum?.base64;
      if (!checksum || checksums.has(checksum)) throw new Error("Final replay violates the legacy unique-checksum constraint");
      checksums.add(checksum);
    }
  }
  for (const table of LEGACY_TABLES) {
    const declared = [...baseline.footer.tables[table].columns].sort();
    for (const [key, fields] of final.get(table)!) {
      if (digest(Object.keys(fields).sort()) !== digest(declared)) throw new Error("Replay field set differs from the baseline source schema");
      if (table !== "feeds_groups" && present.get(table)?.has(key) && digest(present.get(table)!.get(key)) === digest(fields)) continue;
      validateLegacyShape(table, fields);
    }
  }
  const mysql = await import("mysql2/promise");
  const writer = await mysql.createConnection({ uri: url, multipleStatements: false });
  try {
    // Release outgoing unique CRC keys before applying swaps or reuse. Missing rows
    // are an admissible resumable state because both complete images are retained.
    for (const table of ["feeds", "favicons"] as const) {
      for (const [key, fields] of present.get(table)!) {
        const next = final.get(table)!.get(key);
        if (!next || digest(next.url_checksum) !== digest(fields.url_checksum)) {
          await writer.execute(`DELETE FROM \`${prefix}${table}\` WHERE id=?`, [key]);
          present.get(table)!.delete(key);
        }
      }
    }
    // Fixed SQL identifiers and bound byte values only. MyISAM is nontransactional:
    // each row is idempotent and the preflight admits only baseline/final states.
    for (const table of LEGACY_TABLES) {
      if (table === "feeds_groups") continue;
      for (const [key, fields] of final.get(table)!) {
        if (present.get(table)?.has(key) && digest(present.get(table)!.get(key)) === digest(fields)) continue;
        const columns = Object.keys(fields);
        if (columns.some(column => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column))) throw new Error("Invalid neutral snapshot column");
        const values = columns.map(column => fields[column] ? strictBase64(fields[column]!.base64) : null);
        if (present.get(table)?.has(key)) await writer.execute(`UPDATE \`${prefix}${table}\` SET ${columns.map(column => `\`${column}\`=?`).join(",")} WHERE id=?`, [...values, key]);
        else await writer.execute(`INSERT INTO \`${prefix}${table}\` (${columns.map(column => `\`${column}\``).join(",")}) VALUES (${columns.map(() => "?").join(",")})`, values);
      }
    }
    // Membership rows have no primary key. Only rows represented by either reviewed
    // snapshot are removable; replace each pair independently, including duplicates.
    for (const [key, fields] of pairs) {
      const feed = fields.feed_id ? strictBase64(fields.feed_id.base64) : null; const group = fields.group_id ? strictBase64(fields.group_id.base64) : null;
      const wanted = [...final.get("feeds_groups")!.values()].filter(value => digest(value) === key).length;
      await writer.execute(`DELETE FROM \`${prefix}feeds_groups\` WHERE feed_id <=> ? AND group_id <=> ?`, [feed, group]);
      for (let index = 0; index < wanted; index++) await writer.execute(`INSERT INTO \`${prefix}feeds_groups\` (feed_id,group_id) VALUES (?,?)`, [feed, group]);
    }
    for (const table of [...LEGACY_TABLES].reverse()) {
      if (table === "feeds_groups") continue;
      for (const key of present.get(table)!.keys()) if (!final.get(table)!.has(key)) await writer.execute(`DELETE FROM \`${prefix}${table}\` WHERE id=?`, [key]);
    }
  } finally { await writer.end(); }
  const verification = await mysqlSource(url, prefix, freeze);
  try {
    for (const table of LEGACY_TABLES) {
      const expected = [...final.get(table)!.values()].map(digest).sort(); const actual: string[] = [];
      for await (const fields of verification.rows(table)) actual.push(digest(fields));
      if (digest(expected) !== digest(actual.sort())) throw new Error("Final MySQL rollback field conservation failed; keep both writers disabled");
    }
  } finally { await verification.close(); }
  return { ok: true, targetFingerprint: fingerprint, finalFingerprint: desired.footer.fingerprint };
}

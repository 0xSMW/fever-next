import { normalizeUrl } from "../legacy-url";
import { sha256 } from "../crypto";
import { digest, snapshotRows } from "./snapshot";
import { mapLegacyRow, MappingError, text, type MappedConfiguration, type MappedRow } from "./transform";
import { mapStarterRow } from "./starter";
import { POLICY_VERSION, type MigrationReport, type RowDisposition, type Snapshot, type SnapshotRow } from "./types";

const knownColumns: Record<string, string[]> = {
  _config: ["id", "cfg", "prefs"], groups: ["id", "title", "item_excerpts", "item_allows", "unread_counts", "sort_order"],
  favicons: ["id", "cache", "url", "url_checksum", "last_cached_on_time"],
  feeds: ["id", "favicon_id", "title", "url", "url_checksum", "site_url", "domain", "requires_auth", "auth", "is_spark", "prevents_hotlinking", "item_excerpts", "item_allows", "unread_counts", "sort_order", "last_refreshed_on_time", "last_updated_on_time", "last_added_on_time"],
  feeds_groups: ["feed_id", "group_id"], items: ["id", "feed_id", "uid", "title", "author", "description", "link", "url_checksum", "read_on_time", "is_saved", "created_on_time", "added_on_time"],
  links: ["id", "feed_id", "item_id", "is_blacklisted", "is_item", "is_local", "is_first", "title", "url", "url_checksum", "title_url_checksum", "weight", "created_on_time"],
  User: ["id", "email", "password", "createdAt"], Group: ["id", "name"], Feed: ["id", "url", "title", "siteUrl", "groupId", "userId", "createdAt"], Item: ["id", "feedId", "title", "link", "content", "pubDate", "read", "createdAt"],
};
// A subscription creation timestamp is not a legacy last-item-added clock.
// Preserve the starter value in the encrypted archive rather than claiming a
// mapped field or inventing fetch-state history from a different event.
const sourceOnlyColumns: Record<string, string[]> = { Feed: ["createdAt"] };
export interface Analysis { report: MigrationReport; dispositions: Map<string, RowDisposition>; config?: MappedConfiguration; }
export function mapRow(snapshot: Snapshot, row: SnapshotRow): MappedRow { return snapshot.header.source === "mysql" ? mapLegacyRow(row) : mapStarterRow(row); }
export const dispositionKey = (row: Pick<SnapshotRow, "table" | "ordinal">) => `${row.table}:${row.ordinal}`;
export async function analyzeSnapshot(snapshot: Snapshot): Promise<Analysis> {
  const report: MigrationReport = {
    format: 1, policy: POLICY_VERSION, sourceFingerprint: snapshot.footer.fingerprint, sourceKind: snapshot.header.source,
    sourceVersion: null, generatedAt: new Date().toISOString(), frozenAt: Math.floor(Date.parse(snapshot.header.freeze.at) / 1000),
    counts: Object.fromEntries(Object.entries(snapshot.footer.tables).map(([table, manifest]) => [table, { source: manifest.rows, import: 0, quarantine: 0, duplicateMembership: 0 }])),
    fieldDigests: Object.fromEntries(Object.entries(snapshot.footer.tables).map(([table, manifest]) => [table, manifest.fieldDigests])),
    state: { read: 0, unread: 0, saved: 0, memberships: 0 }, issues: [], conservation: false, readyToImport: false,
  };
  const dispositions = new Map<string, RowDisposition>();
  const ids = new Map<string, Set<number>>(); const itemFeeds = new Map<number, number>();
  const identities = new Map<string, string>(); const aliases = new Map<string, string>(); const memberships = new Set<string>(); const canonical = new Map<string, string>(); const checksums = new Map<string, string>();
  let config: MappedConfiguration | undefined;
  const issue = (row: SnapshotRow, code: string, message: string, field?: string, severity: "warning" | "blocking" = "blocking") => {
    report.issues.push({ code, severity, table: row.table, ordinal: row.ordinal, field, message, rowDigest: digest(row) });
  };
  const ensureParent = (kind: string, id: number, field: string) => { if (!ids.get(kind)?.has(id)) throw new MappingError("ORPHAN_OR_QUARANTINED_PARENT", field, "Referenced source row is absent or quarantined"); };
  for await (const row of snapshotRows(snapshot)) {
    const disposition: RowDisposition = { table: row.table, ordinal: row.ordinal, digest: digest(row), disposition: "import", fields: Object.fromEntries(Object.keys(row.fields).map(key => [key, knownColumns[row.table]?.includes(key) && !sourceOnlyColumns[row.table]?.includes(key) && row.fields[key] !== null ? "mapped" : "restricted-archive"])) };
    try {
      const value = mapRow(snapshot, row);
      // Identity indexes describe accepted rows only. A later parent/checksum
      // failure must not reserve an identity on behalf of a quarantined row.
      const accept: Array<() => void> = [];
      for (const key of Object.keys(row.fields)) if (!knownColumns[row.table]?.includes(key)) issue(row, "UNKNOWN_COLUMN", "Unknown source column retained in the restricted archive", key, "warning");
      if (value.kind !== "membership") {
        if (ids.get(value.kind)?.has(value.id)) throw new MappingError("DUPLICATE_ID", "id", "Duplicate entity ID requires reconciliation");
        disposition.target = { table: value.kind, id: String(value.id) };
      }
      if (value.kind === "config") {
        if (config || value.id !== 1) throw new MappingError("OWNER_AMBIGUITY", "id", "Exactly one source configuration/owner with ID 1 is required");
        config = value; report.sourceVersion = snapshot.header.source === "mysql" ? value.version : null;
        for (const field of value.unknownKeys) issue(row, "UNKNOWN_SERIALIZED_KEY", "Unknown serialized key retained in the restricted archive", field, "warning");
        if (value.preferences.services.some(service => service.enabled === false)) issue(row, "DISABLED_SHARING_DESTINATION", "Unsafe sharing destinations are preserved and visibly disabled", "prefs.services", "warning");
      }
      if (value.kind === "feed" || value.kind === "favicon") {
        if (value.kind === "favicon" && value.id === 1 && value.url !== "favicon.png") throw new MappingError("DEFAULT_FAVICON_ID_COLLISION", "id", "Reserved favicon ID1 is occupied by a non-default source URL");
        const full = normalizeUrl(value.url); const key = `${value.kind}:${sha256(full)}`;
        if (canonical.has(key)) throw new MappingError(canonical.get(key) === full ? "DUPLICATE_URL" : "DIGEST_COLLISION", "url", "Indexed URL identity conflicts with another source entity");
        if (value.kind === "feed" && value.faviconId > 0) ensureParent("favicon", value.faviconId, "favicon_id");
        accept.push(() => { canonical.set(key, full); });
      }
      if (value.kind === "item") {
        ensureParent("feed", value.feedId, "feed_id");
        const rawIdentity = value.uid ? `uid:v1:${value.uid}` : `legacy-row:v1:legacy-row:${value.id}`;
        const identity = `${value.feedId}:${sha256(rawIdentity)}`;
        if (identities.has(identity)) throw new MappingError(identities.get(identity) === rawIdentity ? "DUPLICATE_UID" : "DIGEST_COLLISION", "uid", "A feed contains repeated or colliding UID identity; rows require an explicit resolution");
        if (value.uid) {
          const aliasKey = `${value.feedId}:${sha256(`legacy_uid:${value.uid}`)}`;
          if (aliases.has(aliasKey) && aliases.get(aliasKey) !== value.uid) throw new MappingError("DIGEST_COLLISION", "uid", "Legacy identity alias digest collides with another source UID");
          const uid = value.uid;
          accept.push(() => { aliases.set(aliasKey, uid); });
        }
        accept.push(() => { identities.set(identity, rawIdentity); itemFeeds.set(value.id, value.feedId); });
      }
      if (value.kind === "link") {
        ensureParent("item", value.itemId, "item_id"); ensureParent("feed", value.feedId, "feed_id");
        if (itemFeeds.get(value.itemId) !== value.feedId) throw new MappingError("LINK_FEED_MISMATCH", "feed_id", "Link feed does not match its item's feed");
      }
      if ((value.kind === "link" || value.kind === "item" || value.kind === "feed" || value.kind === "favicon") && value.url) {
        const key = `${value.kind}:${value.checksum}`; const full = normalizeUrl(value.url);
        if (snapshot.header.source === "mysql" && checksums.has(key) && checksums.get(key) !== full) throw new MappingError("LEGACY_CHECKSUM_COLLISION", "url_checksum", "The legacy checksum identifies different canonical URLs");
        accept.push(() => { checksums.set(key, full); });
      }
      if (value.kind === "membership") {
        ensureParent("feed", value.feedId, "feed_id"); ensureParent("group", value.groupId, "group_id");
        const key = `${value.feedId}:${value.groupId}`;
        if (memberships.has(key)) { disposition.disposition = "duplicate-membership"; issue(row, "DUPLICATE_MEMBERSHIP", "Exact duplicate relationship is archived and coalesced with a counted disposition", undefined, "warning"); }
        else { memberships.add(key); report.state.memberships++; }
      }
      if (row.table === "Feed" && row.fields.groupId !== null) {
        const groupId = Number(text(row, "groupId")); ensureParent("group", groupId, "groupId"); report.state.memberships++;
      }
      if (value.kind === "item") { if (value.readAt > 0) report.state.read++; else report.state.unread++; if (value.isSaved) report.state.saved++; }
      for (const commit of accept) commit();
      if (value.kind !== "membership") { const collection = ids.get(value.kind) ?? new Set<number>(); collection.add(value.id); ids.set(value.kind, collection); }
    } catch (error) {
      disposition.disposition = "quarantine";
      const typed = error instanceof MappingError;
      issue(row, typed ? error.code : "MALFORMED_SOURCE_VALUE", typed ? error.message : "Source value failed bounded data-only decoding", typed ? error.field : undefined);
    }
    dispositions.set(dispositionKey(row), disposition);
    const counts = report.counts[row.table];
    if (disposition.disposition === "duplicate-membership") counts.duplicateMembership++;
    else counts[disposition.disposition]++;
  }
  if (!config) report.issues.push({ code: "MISSING_OWNER", severity: "blocking", table: "_config", ordinal: 0, message: "No importable singleton owner configuration was found", rowDigest: "" });
  if (snapshot.header.source === "mysql" && !ids.get("favicon")?.has(1)) report.issues.push({ code: "MISSING_DEFAULT_FAVICON", severity: "blocking", table: "favicons", ordinal: 0, message: "Legacy source has no valid reserved default favicon ID1; repair requires an explicit source-data disposition", rowDigest: "" });
  if (snapshot.header.source === "sqlite") report.issues.push({ code: "STARTER_ABSENT_FIELDS", severity: "warning", table: "snapshot", ordinal: 0, message: "Starter has no GUID, author, saved state, ranking, or preferences. Original content is preserved; read=true maps to sentinel epoch 1, absent saved=false, synthetic starter:<id> identities, and explicit defaults are recorded as derived values", rowDigest: "" });
  report.conservation = Object.values(report.counts).every(count => count.source === count.import + count.quarantine + count.duplicateMembership);
  report.readyToImport = report.conservation && !!config && !report.issues.some(entry => entry.severity === "blocking");
  return { report, dispositions, config };
}

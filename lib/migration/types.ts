/** Offline, data-only format. No SQL, PHP, or HTML in a snapshot is executable. */
export const SNAPSHOT_VERSION = 1 as const;
export const POLICY_VERSION = "fever-import-1";
export const LEGACY_TABLES = ["_config", "groups", "favicons", "feeds", "feeds_groups", "items", "links"] as const;
export const STARTER_TABLES = ["User", "Group", "Feed", "Item"] as const;
export type SourceKind = "mysql" | "sqlite";
export type SourceTable = typeof LEGACY_TABLES[number] | typeof STARTER_TABLES[number];
/** All non-NULL source fields retain their exact bytes, even numeric fields. */
export type Cell = { base64: string } | null;
export interface SnapshotRow { kind: "row"; table: SourceTable; ordinal: number; fields: Record<string, Cell>; }
export interface TableManifest { columns: string[]; rows: number; digest: string; fieldDigests: Record<string, string>; maxId: string | null; }
export interface SnapshotHeader {
  kind: "header"; format: typeof SNAPSHOT_VERSION; source: SourceKind;
  createdAt: string; freeze: { acknowledged: true; at: string; evidence: string };
  metadata: { database: string; version: string; charset: string; collation: string; prefix?: string; engines: Record<string, string> };
}
export interface SnapshotFooter { kind: "footer"; fingerprint: string; tables: Record<string, TableManifest>; }
export interface Snapshot { header: SnapshotHeader; footer: SnapshotFooter; path: string; }
export interface SourceAdapter {
  header: SnapshotHeader;
  tables: readonly SourceTable[];
  columns(table: SourceTable): Promise<string[]>;
  rows(table: SourceTable): AsyncIterable<Record<string, Cell>>;
  close(): Promise<void>;
}
export interface MigrationIssue {
  code: string; severity: "warning" | "blocking"; table: string; ordinal: number;
  field?: string; message: string; rowDigest: string;
}
export interface RowDisposition {
  table: SourceTable; ordinal: number; digest: string;
  disposition: "import" | "quarantine" | "duplicate-membership";
  fields: Record<string, "mapped" | "restricted-archive" | "derived">;
  target?: { table: string; id: string };
}
export interface MigrationReport {
  format: 1; policy: string; sourceFingerprint: string; sourceKind: SourceKind;
  sourceVersion: number | null; generatedAt: string; frozenAt: number;
  counts: Record<string, { source: number; import: number; quarantine: number; duplicateMembership: number }>;
  fieldDigests: Record<string, Record<string, string>>;
  state: { read: number; unread: number; saved: number; memberships: number };
  issues: MigrationIssue[]; conservation: boolean; readyToImport: boolean;
}

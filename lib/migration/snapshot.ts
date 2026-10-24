import { createHash, type Hash } from "node:crypto";
import { boundedLines, newRestrictedFile } from "./files";
import { strictBase64 } from "./php";
import { LEGACY_TABLES, SNAPSHOT_VERSION, STARTER_TABLES, type Cell, type Snapshot, type SnapshotFooter, type SnapshotHeader, type SnapshotRow, type SourceAdapter, type SourceTable, type TableManifest } from "./types";

export function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Buffer.isBuffer(value)) return stableJson(value.toJSON());
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Unsupported non-data snapshot value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
class TableCounter {
  rows = 0; maxId: bigint | null = null;
  hash = createHash("sha256"); fields: Record<string, Hash> = Object.create(null);
  constructor(readonly columns: string[]) { for (const column of columns) this.fields[column] = createHash("sha256"); }
  add(row: SnapshotRow) {
    if (row.ordinal !== this.rows + 1 || stableJson(Object.keys(row.fields).sort()) !== stableJson([...this.columns].sort())) throw new Error("Snapshot row order or field set changed");
    this.rows++; this.hash.update(stableJson(row) + "\n");
    for (const key of this.columns) this.fields[key].update(stableJson(row.fields[key]) + "\n");
    const id = row.fields.id;
    if (id) {
      const text = strictBase64(id.base64).toString("latin1");
      if (/^\d+$/.test(text)) { const number = BigInt(text); if (this.maxId === null || number > this.maxId) this.maxId = number; }
    }
  }
  finish(): TableManifest { return { columns: this.columns, rows: this.rows, digest: this.hash.digest("hex"), fieldDigests: Object.fromEntries(Object.entries(this.fields).map(([key, value]) => [key, value.digest("hex")])), maxId: this.maxId?.toString() ?? null }; }
}
export async function extractSnapshot(source: SourceAdapter, output: string): Promise<SnapshotFooter> {
  const file = await newRestrictedFile(output).catch(async (error) => { await source.close(); throw error; });
  try {
    await file.writeFile(stableJson(source.header) + "\n");
    const tables: Record<string, TableManifest> = Object.create(null);
    for (const table of source.tables) {
      const columns = await source.columns(table);
      const counter = new TableCounter(columns);
      // Empty tables still have a descriptor, so absent data and absent tables differ.
      await file.writeFile(stableJson({ kind: "table", table, columns }) + "\n");
      for await (const fields of source.rows(table)) {
        const row: SnapshotRow = { kind: "row", table, ordinal: counter.rows + 1, fields };
        counter.add(row); await file.writeFile(stableJson(row) + "\n");
      }
      tables[table] = counter.finish();
    }
    const footer: SnapshotFooter = { kind: "footer", fingerprint: digest({ header: source.header, tables }), tables };
    await file.writeFile(stableJson(footer) + "\n"); await file.sync(); return footer;
  } finally { await file.close(); await source.close(); }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validateCell(value: unknown): asserts value is Cell {
  if (value === null) return;
  if (!record(value) || Object.keys(value).length !== 1 || typeof value.base64 !== "string") throw new Error("Invalid snapshot cell");
  strictBase64(value.base64);
}
/** Full integrity pass must succeed before an import performs its first write. */
export async function inspectSnapshot(path: string, maxRows = 5_000_000): Promise<Snapshot> {
  let header: SnapshotHeader | undefined; let footer: SnapshotFooter | undefined;
  let current: SourceTable | undefined; let counter: TableCounter | undefined; let total = 0;
  const tables: Record<string, TableManifest> = Object.create(null);
  let expected: readonly string[] = []; let tableIndex = 0;
  for await (const line of boundedLines(path)) {
    const value: unknown = JSON.parse(line);
    if (!record(value) || footer) throw new Error("Malformed or trailing snapshot record");
    if (!header) {
      if (value.kind !== "header" || value.format !== SNAPSHOT_VERSION || !["mysql", "sqlite"].includes(String(value.source)) || !record(value.freeze) || value.freeze.acknowledged !== true || typeof value.freeze.evidence !== "string" || !value.freeze.evidence || !Number.isFinite(Date.parse(String(value.freeze.at))) || !record(value.metadata)) throw new Error("Unsupported snapshot header or missing freeze evidence");
      header = value as unknown as SnapshotHeader;
      expected = header.source === "mysql" ? LEGACY_TABLES : STARTER_TABLES; continue;
    }
    if (value.kind === "table") {
      if (counter && current) tables[current] = counter.finish();
      if (value.table !== expected[tableIndex++] || !Array.isArray(value.columns) || !value.columns.length || value.columns.some(x => typeof x !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(x)) || new Set(value.columns).size !== value.columns.length) throw new Error("Invalid table descriptor or table ordering");
      current = value.table as SourceTable; counter = new TableCounter(value.columns as string[]); continue;
    }
    if (value.kind === "row") {
      if (!counter || value.table !== current || !record(value.fields) || !Number.isSafeInteger(value.ordinal) || ++total > maxRows) throw new Error("Invalid row or snapshot row limit exceeded");
      Object.values(value.fields).forEach(validateCell); counter.add(value as unknown as SnapshotRow); continue;
    }
    if (value.kind === "footer") {
      if (counter && current) tables[current] = counter.finish();
      if (tableIndex !== expected.length || stableJson(value.tables) !== stableJson(tables) || value.fingerprint !== digest({ header, tables })) throw new Error("Snapshot fingerprint, table counts, or field hashes do not reconcile");
      footer = value as unknown as SnapshotFooter; continue;
    }
    throw new Error("Unknown snapshot record");
  }
  if (!header || !footer) throw new Error("Incomplete snapshot");
  return { header, footer, path };
}
export async function* snapshotRows(snapshot: Snapshot): AsyncGenerator<SnapshotRow> {
  // The caller first validates the complete snapshot; each iterator verifies it again
  // before streaming to make accidental replacement between stages visible.
  const current = await inspectSnapshot(snapshot.path);
  if (current.footer.fingerprint !== snapshot.footer.fingerprint) throw new Error("Snapshot changed since inspection");
  for await (const line of boundedLines(snapshot.path)) {
    const value = JSON.parse(line);
    if (value.kind === "row") yield value as SnapshotRow;
  }
}

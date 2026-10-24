/** Source-only adapters. Never import this module from web or worker runtime. */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { LEGACY_TABLES, SNAPSHOT_VERSION, STARTER_TABLES, type Cell, type SnapshotHeader, type SourceAdapter, type SourceTable } from "./types";

function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid source identifier");
  return name;
}
export function freezeRecord(at: string, evidence: string): SnapshotHeader["freeze"] {
  if (!Number.isFinite(Date.parse(at)) || !evidence.trim()) throw new Error("Explicit source freeze time and evidence are required");
  return { acknowledged: true, at: new Date(at).toISOString(), evidence };
}
export async function mysqlSource(url: string, prefix: string, freeze: SnapshotHeader["freeze"]): Promise<SourceAdapter> {
  const parsed = new URL(url);
  if (parsed.protocol !== "mysql:") throw new Error("LEGACY_MYSQL_URL must use mysql:");
  identifier(prefix);
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection({ uri: url, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, dateStrings: true });
  try {
    // MyISAM consistency comes from an external freeze. READ ONLY also protects
    // transactional tables, and this adapter issues only metadata/SELECT statements.
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    const [meta] = await connection.query("SELECT DATABASE() AS db, VERSION() AS version, @@character_set_database AS charset, @@collation_database AS collation");
    const info = (meta as Array<Record<string, string>>)[0];
    const [engineRows] = await connection.query("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)", [LEGACY_TABLES.map(table => prefix + table)]);
    const engines = Object.fromEntries((engineRows as Array<Record<string, string>>).map(row => [row.TABLE_NAME, row.ENGINE]));
    if (Object.keys(engines).length !== LEGACY_TABLES.length) throw new Error("Source is missing a required legacy table");
    const descriptions = new Map<SourceTable, string[]>();
    for (const table of LEGACY_TABLES) {
      const [rows] = await connection.query(`SHOW COLUMNS FROM \`${identifier(prefix + table)}\``);
      descriptions.set(table, (rows as Array<{ Field: string }>).map(row => identifier(row.Field)));
    }
    return {
      header: { kind: "header", format: SNAPSHOT_VERSION, source: "mysql", createdAt: new Date().toISOString(), freeze, metadata: { database: info.db, version: info.version, charset: info.charset, collation: info.collation, prefix, engines } },
      tables: LEGACY_TABLES,
      async columns(table) { const names = descriptions.get(table); if (!names) throw new Error("Unknown source table"); return names; },
      async *rows(table) {
        const columns = descriptions.get(table); if (!columns) throw new Error("Unknown source table");
        const selection = columns.map(column => `CAST(\`${column}\` AS BINARY) AS \`${column}\``).join(",");
        const order = columns.includes("id") ? "`id`" : "`feed_id`, `group_id`";
        for (let offset = 0; ; offset += 250) {
          const [batch] = await connection.query(`SELECT ${selection} FROM \`${identifier(prefix + table)}\` ORDER BY ${order} LIMIT 250 OFFSET ?`, [offset]);
          const rows = batch as Array<Record<string, Buffer | null>>;
          for (const row of rows) yield Object.fromEntries(columns.map(column => [column, row[column] === null ? null : { base64: Buffer.from(row[column]!).toString("base64") }])) as Record<string, Cell>;
          if (rows.length < 250) break;
        }
      },
      async close() { await connection.end(); },
    };
  } catch (error) { await connection.end(); throw error; }
}
export async function sqliteSource(path: string, freeze: SnapshotHeader["freeze"]): Promise<SourceAdapter> {
  if (!isAbsolute(path) || !(await stat(path)).isFile() || await realpath(path) !== path) throw new Error("Explicit existing non-symlink SQLite source path is required");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON"); db.defaultSafeIntegers(true); db.exec("BEGIN");
  const descriptions = new Map<SourceTable, string[]>();
  try {
    for (const table of STARTER_TABLES) {
      const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => identifier(column.name));
      if (!columns.includes("id")) throw new Error("Unsupported starter table shape"); descriptions.set(table, columns);
    }
    const version = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    return {
      header: { kind: "header", format: SNAPSHOT_VERSION, source: "sqlite", createdAt: new Date().toISOString(), freeze, metadata: { database: "starter", version: version.version, charset: "UTF-8", collation: "BINARY", engines: Object.fromEntries(STARTER_TABLES.map(table => [table, "sqlite"])) } },
      tables: STARTER_TABLES,
      async columns(table) { const columns = descriptions.get(table); if (!columns) throw new Error("Unknown starter table"); return columns; },
      async *rows(table) {
        const columns = descriptions.get(table); if (!columns) throw new Error("Unknown starter table");
        const selection = columns.map(column => `CAST("${column}" AS BLOB) AS "${column}"`).join(",");
        for (const row of db.prepare(`SELECT ${selection} FROM "${table}" ORDER BY "id"`).iterate() as Iterable<Record<string, Buffer | null>>) {
          yield Object.fromEntries(columns.map(column => [column, row[column] === null ? null : { base64: row[column]!.toString("base64") }])) as Record<string, Cell>;
        }
      },
      async close() { db.exec("ROLLBACK"); db.close(); },
    };
  } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
}

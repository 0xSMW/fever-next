import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { getConfig, SCHEMA_VERSION } from "../lib/config";
import { fileDigest, inputFile, newRestrictedFile, writeRestrictedJson } from "../lib/migration/files";
import { assertSchema, targetFingerprint } from "../lib/migration/target";

export function pgEnvironment(url: string): NodeJS.ProcessEnv {
  const target = new URL(url); const config = getConfig({ ...process.env, DATABASE_URL: url });
  if (config.databaseSsl && config.databaseSsl.ca && !process.env.FEVER_PG_SSL_ROOT_CERT) throw new Error("PostgreSQL client tools require FEVER_PG_SSL_ROOT_CERT for the configured custom CA");
  // Never put a credential-bearing connection string in process argv.
  return { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: process.env.NODE_ENV ?? "production", LANG: "C.UTF-8", PGHOST: target.hostname, PGPORT: target.port || "5432", PGDATABASE: decodeURIComponent(target.pathname.slice(1)), PGUSER: decodeURIComponent(target.username), PGPASSWORD: decodeURIComponent(target.password), PGCONNECT_TIMEOUT: "10", PGSSLMODE: config.databaseSsl ? "verify-full" : "disable", ...(config.databaseSsl ? { PGSSLROOTCERT: process.env.FEVER_PG_SSL_ROOT_CERT ?? "system" } : {}) };
}
async function clientTool(binary: "pg_dump" | "pg_restore", args: string[], url: string, output?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, env: pgEnvironment(url), stdio: ["ignore", output ?? "pipe", "pipe"] });
    let stdout = ""; let stderrBytes = 0;
    child.stdout?.on("data", part => { if (stdout.length < 64 * 1024) stdout += part.toString(); });
    // Drain errors without exposing relation names, source contents, or credentials.
    child.stderr?.on("data", part => { stderrBytes += part.length; if (stderrBytes > 1024 * 1024) child.kill("SIGTERM"); });
    child.once("error", () => reject(new Error("PostgreSQL client executable failed to start")));
    child.once("exit", code => code === 0 ? resolve(stdout) : reject(new Error("PostgreSQL client command failed; archive or restore is incomplete")));
  });
}
async function clientMajor(binary: "pg_dump" | "pg_restore", url: string): Promise<number> {
  const version = await clientTool(binary, ["--version"], url); const match = /\(PostgreSQL\) (\d+)/.exec(version);
  if (!match) throw new Error("Unrecognized PostgreSQL client version"); return Number(match[1]);
}
export interface BackupManifest { format: 1; archiveSha256: string; bytes: number; completedAt: string; schemaVersion: number; postgresMajor: number; targetFingerprint: string; sourceFingerprint: string | null; }
interface ReviewedMigration { version: number; file: string; sha256: string; }
/** Only an exact checksum-reviewed prefix of this release is restorable. */
export async function reviewedRestoreHistory(schemaVersion: number): Promise<ReviewedMigration[]> {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > SCHEMA_VERSION) throw new Error("Backup schema version is not supported by this release");
  const manifest = JSON.parse(await readFile(new URL("../migrations/manifest.json", import.meta.url), "utf8")) as { format: number; migrations: ReviewedMigration[] };
  if (manifest.format !== 1 || !Array.isArray(manifest.migrations) || manifest.migrations.length !== SCHEMA_VERSION) throw new Error("Reviewed restore migration manifest does not match this release");
  for (const [index, entry] of manifest.migrations.entries()) {
    if (entry.version !== index + 1 || !/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid reviewed restore migration entry");
    const sql = await readFile(new URL(`../migrations/${entry.file}`, import.meta.url), "utf8");
    if (createHash("sha256").update(sql).digest("hex") !== entry.sha256) throw new Error("Reviewed restore migration checksum changed");
  }
  return manifest.migrations.slice(0, schemaVersion);
}
export function assertRestoredHistory(schemaVersion: number, installation: Array<{ schema_version: number }>, applied: Array<{ version: number; filename: string; sha256: string }>, reviewed: ReviewedMigration[]) {
  if (installation.length !== 1 || installation[0].schema_version !== schemaVersion || applied.length !== reviewed.length || reviewed.length !== schemaVersion) throw new Error("Restored schema version or migration history does not match the reviewed archive version");
  for (const [index, entry] of applied.entries()) {
    const expected = reviewed[index];
    if (entry.version !== expected.version || entry.filename !== expected.file || entry.sha256 !== expected.sha256) throw new Error("Restored migration history diverges from this release");
  }
}
export async function backup(client: Client, url: string, output: string): Promise<BackupManifest> {
  await assertSchema(client);
  const identity = await targetFingerprint(client, url);
  const major = Math.floor(Number(identity.identity.server_version) / 10000);
  if (await clientMajor("pg_dump", url) !== major) throw new Error("Use the same PostgreSQL major for pg_dump and the server");
  const file = await newRestrictedFile(output);
  try { await clientTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--compress=6"], url, file.fd); await file.sync(); } finally { await file.close(); }
  const source = (await client.query("SELECT source_fingerprint FROM migration_runs ORDER BY id DESC LIMIT 1")).rows[0]?.source_fingerprint ?? null;
  const manifest: BackupManifest = { format: 1, archiveSha256: await fileDigest(output), bytes: (await stat(output)).size, completedAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION, postgresMajor: major, targetFingerprint: identity.fingerprint, sourceFingerprint: source };
  await writeRestrictedJson(`${output}.manifest.json`, manifest);
  await client.query("UPDATE installation SET migration_provenance=jsonb_set(migration_provenance,'{operatorBackup}',$1::jsonb),updated_at=now() WHERE id=1", [JSON.stringify(manifest)]);
  return manifest;
}
export async function restore(client: Client, url: string, archive: string, manifest: BackupManifest, expectedSha256: string) {
  if (manifest.format !== 1 || manifest.archiveSha256 !== expectedSha256 || await fileDigest(archive) !== expectedSha256) throw new Error("Backup manifest or explicitly approved archive digest does not match");
  const reviewed = await reviewedRestoreHistory(manifest.schemaVersion);
  const identity = await targetFingerprint(client, url); const major = Math.floor(Number(identity.identity.server_version) / 10000);
  if (manifest.postgresMajor !== major || await clientMajor("pg_restore", url) !== major) throw new Error("Restore must use the rehearsed matching PostgreSQL major");
  const existing = await client.query("SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')");
  if (Number(existing.rows[0].count) !== 0) throw new Error("Restore destination must be an explicitly selected empty database");
  await clientTool("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--dbname", decodeURIComponent(new URL(url).pathname.slice(1)), await inputFile(archive)], url);
  // Latch the isolated restored installation before validating history. A failed
  // validation must never leave a restored ready sentinel behind.
  await client.query("UPDATE installation SET status='maintenance',setup_closed=true,updated_at=now() WHERE id=1");
  const installation = (await client.query("SELECT schema_version FROM installation WHERE id=1")).rows;
  const applied = (await client.query("SELECT version,filename,sha256 FROM fever_schema_migrations ORDER BY version")).rows;
  assertRestoredHistory(manifest.schemaVersion, installation, applied, reviewed);
  const evidence = { completedAt: new Date().toISOString(), archiveSha256: expectedSha256, sourceFingerprint: manifest.targetFingerprint, targetFingerprint: identity.fingerprint,
    schemaVersion: manifest.schemaVersion, restoredSchemaVersion: manifest.schemaVersion, releaseSchemaVersion: SCHEMA_VERSION, requiresMigration: manifest.schemaVersion < SCHEMA_VERSION };
  await client.query("UPDATE installation SET migration_provenance=jsonb_set(migration_provenance,'{operatorRestore}',$1::jsonb),updated_at=now() WHERE id=1", [JSON.stringify(evidence)]);
  return evidence;
}

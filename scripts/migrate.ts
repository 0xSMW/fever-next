import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { argumentsFor, confirmation, environment, loadExplicitEnvironment, required, safeFailure } from "../cli/common";
import { assertTarget, closeTarget, connectTarget, lockTarget } from "../lib/migration/target";
import { SCHEMA_VERSION } from "../lib/config";

interface Manifest { format: 1; migrations: Array<{ version: number; file: string; sha256: string }>; }
async function main() {
  const { values, positionals } = argumentsFor(["env-file", "target-url-env", "target-fingerprint", "confirm"]);
  await loadExplicitEnvironment(values["env-file"]);
  if (!["status", "apply"].includes(positionals[0])) throw new Error("Use migrate status or apply");
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
  const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== 1 || !Array.isArray(manifest.migrations) || manifest.migrations.length !== SCHEMA_VERSION) throw new Error("Migration manifest does not match the release schema version");
  const checked = [];
  for (const [index, entry] of manifest.migrations.entries()) {
    if (entry.version !== index + 1 || !/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid reviewed migration entry");
    const sql = await readFile(resolve(dir, entry.file), "utf8");
    if (createHash("sha256").update(sql).digest("hex") !== entry.sha256) throw new Error("Reviewed migration checksum changed");
    checked.push({ ...entry, sql });
  }
  const url = environment(required(values, "target-url-env")); const fingerprint = required(values, "target-fingerprint");
  const client = await connectTarget(url);
  try {
    await assertTarget(client, url, fingerprint);
    const exists = (await client.query("SELECT to_regclass('public.fever_schema_migrations') AS name")).rows[0].name;
    const applied = exists ? (await client.query("SELECT version,filename,sha256 FROM fever_schema_migrations ORDER BY version")).rows : [];
    for (const [index, entry] of applied.entries()) {
      const expected = checked[index];
      if (!expected || entry.version !== expected.version || entry.filename !== expected.file || entry.sha256 !== expected.sha256) throw new Error("Target migration history diverges from this release");
    }
    if (positionals[0] === "status") { console.log(JSON.stringify({ targetFingerprint: fingerprint, applied: applied.length, available: checked.length, pending: checked.slice(applied.length).map(({ file }) => file) })); return; }
    confirmation(values, "migrate", fingerprint); await lockTarget(client);
    // Journal creation is fixed application-owned DDL, never source snapshot input.
    await client.query("CREATE TABLE IF NOT EXISTS fever_schema_migrations(version integer PRIMARY KEY,filename text NOT NULL UNIQUE,sha256 varchar(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())");
    // Re-read under the advisory lock to close the status/apply race.
    const locked = (await client.query("SELECT version,filename,sha256 FROM fever_schema_migrations ORDER BY version")).rows;
    if (locked.length !== applied.length) throw new Error("Migration history changed; rerun the command");
    for (const entry of checked.slice(applied.length)) {
      await client.query("BEGIN");
      try {
        await client.query(entry.sql);
        await client.query("UPDATE installation SET schema_version=$1,updated_at=now() WHERE id=1", [entry.version]);
        await client.query("INSERT INTO fever_schema_migrations(version,filename,sha256) VALUES($1,$2,$3)", [entry.version, entry.file, entry.sha256]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
    console.log(JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION, targetFingerprint: fingerprint }));
  } finally { await closeTarget(client); }
}
main().catch(safeFailure);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Client } from "pg";
import { SCHEMA_VERSION } from "../lib/config";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import { feverDigestVerifier } from "../lib/auth/fever";
import { decryptSecret, encryptSecret, encryptionKeyId } from "../lib/crypto";
import { closeDatabase } from "../lib/db/client";
import { assertSchema, assertTarget, closeTarget, connectTarget, targetFingerprint } from "../lib/migration/target";

const enabled = process.env.FEVER_SCHEMA_UPGRADE_TESTS === "1";
const phase = process.env.FEVER_SCHEMA_DRILL_PHASE ?? "all";
const node24 = process.execPath;
const host = "ep-silent-snow-aroq4quy.c-4.us-west-2.aws.neon.tech";
const rootFingerprint = "d3e876746c7f0a6b829a26d9a9384d2628c1fb2c630a4078ac25451b23d56d9b";
const privateDir = process.env.FEVER_SCHEMA_DRILL_PRIVATE_DIR ?? "/private/tmp/feedafever-ops-private-20261024";
const evidenceDir = resolve(process.env.FEVER_TEST_EVIDENCE_DIR ?? "tests/.artifacts/schema2");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const receipt = async (name: string, result: unknown) => {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/${name}.json`, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
};
function cli(url: string, fingerprint: string, script: string, command: string, extra: string[] = []) {
  const started = performance.now();
  const stdout = execFileSync(node24, ["--network-family-autoselection-attempt-timeout=1000", "--conditions=react-server", "--import", "tsx",
    script, command, "--target-url-env", "FEVER_SCHEMA_DRILL_DATABASE_URL", "--target-fingerprint", fingerprint,
    ...(command === "status" ? [] : ["--confirm", `${script === "scripts/migrate.ts" ? "migrate" : command}:${fingerprint}`]), ...extra],
  { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FEVER_SCHEMA_DRILL_DATABASE_URL: url } });
  return { result: JSON.parse(stdout), elapsedMs: Math.round(performance.now() - started) };
}
async function inventory(client: Client) {
  const tables: Record<string, { rows: number; sha256: string }> = {};
  for (const { tablename } of (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    assert.match(tablename, /^[a-z_]+$/);
    const rows = (await client.query(`SELECT to_jsonb(t)::text AS row FROM "${tablename}" t`)).rows.map(({ row }) => {
      const parsed = JSON.parse(row);
      if (tablename === "installation") { delete parsed.updated_at; delete parsed.schema_version; delete parsed.migration_provenance.operatorRestore; }
      return JSON.stringify(parsed);
    }).sort();
    tables[tablename] = { rows: rows.length, sha256: digest(rows) };
  }
  const sequences = (await client.query("SELECT sequencename,last_value::text,start_value::text,increment_by::text FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;
  return { tables, sequences };
}
function conserved(before: Awaited<ReturnType<typeof inventory>>, after: Awaited<ReturnType<typeof inventory>>) {
  for (const table of Object.keys(before.tables)) {
    if (table !== "fever_schema_migrations") assert.deepEqual(after.tables[table], before.tables[table], table);
  }
  assert.deepEqual(after.sequences, before.sequences);
}
async function verifyIndex(client: Client) {
  const row = (await client.query("SELECT am.amname,i.indisvalid,i.indisready,i.indnkeyatts,i.indnatts,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE c.relname='items_feed_navigation_idx' AND c.relnamespace='public'::regnamespace")).rows;
  assert.equal(row.length, 1); assert.equal(row[0].amname, "btree"); assert.equal(row[0].indisvalid, true); assert.equal(row[0].indisready, true);
  assert.equal(row[0].indnkeyatts, 3); assert.equal(row[0].indnatts, 3); assert.match(row[0].definition, /\(feed_id, read_at, is_saved\)$/);
  return row[0];
}
async function sibling(root: Client, database: "fever_schema2_fresh_20261024" | "fever_schema1_restore_20261024") {
  if ((await root.query("SELECT count(*)::int AS n FROM pg_database WHERE datname=$1", [database])).rows[0].n === 0) await root.query(`CREATE DATABASE ${database}`);
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`;
  const client = await connectTarget(url.toString());
  try {
    const identity = await targetFingerprint(client, url.toString());
    assert.equal(identity.identity.endpoint, `${host}:5432`); assert.equal(identity.identity.database, database);
    await assertTarget(client, url.toString(), identity.fingerprint);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S')")).rows[0].n, 0, "Refusing a populated sibling database");
    return { client, url: url.toString(), fingerprint: identity.fingerprint, database };
  } catch (error) { await closeTarget(client); throw error; }
}

test("schema2 isolated fresh install, v1 upgrade and retained-v1 recovery", { skip: !enabled, timeout: 900_000 }, async t => {
  assert.equal(process.versions.node, "24.22.1"); assert.equal(SCHEMA_VERSION, 2);
  assert.ok(["all", "upgrade", "fresh", "restore-v1", "verify"].includes(phase));
  const rootUrl = new URL(process.env.DATABASE_URL!); assert.equal(rootUrl.hostname, host); assert.equal(rootUrl.pathname, "/neondb");
  const root = await connectTarget(rootUrl.toString());
  try {
    await assertTarget(root, rootUrl.toString(), rootFingerprint);
    if (phase !== "verify") {
      assert.equal((await root.query("SELECT count(*)::int AS n FROM owner")).rows[0].n, 0, "Refusing an existing installation owner");
      assert.equal((await root.query("SELECT status FROM installation WHERE id=1")).rows[0].status, "uninitialized");
    }
    if (phase === "verify") await t.test("read-only sibling verification with recorded root upgrade evidence", async () => {
      const upgrade = JSON.parse(await readFile(`${evidenceDir}/v1-upgrade.json`, "utf8"));
      assert.equal(upgrade.applied.result.schemaVersion, 2); assert.equal(upgrade.after.tables.fever_schema_migrations.rows, 2);
      for (const [file, database] of [["fresh-install", "fever_schema2_fresh_20261024"], ["v1-backup-continuity", "fever_schema1_restore_20261024"]]) {
        const previous = JSON.parse(await readFile(`${evidenceDir}/${file}.json`, "utf8"));
        const url = new URL(rootUrl); url.pathname = `/${database}`;
        const client = await connectTarget(url.toString());
        try {
          await assertTarget(client, url.toString(), previous.targetFingerprint); await assertSchema(client); await verifyIndex(client);
          if (file === "v1-backup-continuity") {
            assert.deepEqual(await inventory(client), previous.after);
            assert.equal((await client.query("SELECT status FROM installation WHERE id=1")).rows[0].status, "maintenance");
          } else {
            assert.equal(JSON.stringify((await client.query("SELECT * FROM fever_schema_migrations ORDER BY version")).rows), JSON.stringify(previous.ledger));
            assert.equal((await client.query("SELECT status FROM installation WHERE id=1")).rows[0].status, "uninitialized");
          }
        } finally { await closeTarget(client); }
      }
      await receipt(`final-verification-${Date.now()}`, { readOnly: true, rootUpgradeVersion2FromRecordedReceipt: true, rootLiveAuditPendingParent: true,
        rootBoundary: "Parent full database suite owns the integration root after this lane's recorded zero-owner cleanup; no root content audit or mutation performed here.",
        freshVersion2AndLedgerUnchanged: true, restoredVersion2AndAllTableDigestsAndSequencesUnchanged: true, restoredMaintenanceLatch: true,
        completedDrillReceipts: ["v1-upgrade.json", "fresh-install.json", "v1-backup-continuity.json"], noMainApply: true });
    });
    if (phase === "all" || phase === "upgrade") await t.test("operator v1→2 upgrade conserves content and sequences; repeat is unchanged", async () => {
      assert.equal((await root.query("SELECT schema_version FROM installation WHERE id=1")).rows[0].schema_version, 1);
      const email = `schema2-${randomUUID()}@example.test`, password = `fixture-${randomUUID()}`;
      let ownsOwner = false, seeding = false;
      try {
        await root.query("BEGIN"); seeding = true;
        await root.query("INSERT INTO owner(id,email,email_key,password_hash) VALUES(1,$1,$2,$3)", [email, email, await hashPassword(password)]); ownsOwner = true;
        await root.query("INSERT INTO reader_preferences(owner_id) VALUES(1)");
        await root.query("INSERT INTO feeds(id,owner_id,url,original_url,canonical_url,url_key,title) VALUES(8101,1,'https://example.test/schema2-a','https://example.test/schema2-a','https://example.test/schema2-a',$1,'É ไทย'),(8102,1,'https://example.test/schema2-b','https://example.test/schema2-b','https://example.test/schema2-b',$2,'Other')", [digest("schema2-a"), digest("schema2-b")]);
        await root.query("INSERT INTO items(id,feed_id,identity_key,title,raw_html,html,read_at,is_saved,published_at,added_at) VALUES(8201,8101,'schema2-a','Saved ไทย','<p>Original 🚀</p>','<p>Rendered</p>',123,true,100,101),(8202,8101,'schema2-b','Unread','full','rendered',0,false,100,102),(8203,8102,'schema2-c','Other','content','content',44,false,100,103)");
        const encrypted = encryptSecret(JSON.stringify({ username: "fixture", password }), "feed:8101");
        await root.query("INSERT INTO feed_credentials(feed_id,ciphertext,key_id) VALUES(8101,$1,$2)", [encrypted, encryptionKeyId(encrypted)]);
        await root.query("INSERT INTO fever_credentials(owner_id,verifier,source) VALUES(1,$1,'schema2-rehearsal')", [feverDigestVerifier(email, password)]);
        await root.query("COMMIT"); seeding = false;
        const before = await inventory(root);
        const status = cli(rootUrl.toString(), rootFingerprint, "scripts/migrate.ts", "status");
        assert.deepEqual(status.result.pending, ["0001_items_feed_navigation.sql"]); assert.equal(status.result.applied, 1);
        const applied = cli(rootUrl.toString(), rootFingerprint, "scripts/migrate.ts", "apply"); assert.equal(applied.result.schemaVersion, 2);
        await assertSchema(root); const after = await inventory(root); conserved(before, after); const index = await verifyIndex(root);
        const rows = (await root.query("SELECT feed_id::text,count(*) FILTER(WHERE read_at=0)::int AS unread,count(*) FILTER(WHERE is_saved)::int AS saved FROM items GROUP BY feed_id ORDER BY feed_id")).rows;
        assert.deepEqual(rows, [{ feed_id: "8101", unread: 1, saved: 1 }, { feed_id: "8102", unread: 0, saved: 0 }]);
        const credential = (await root.query("SELECT ciphertext FROM feed_credentials WHERE feed_id=8101")).rows[0];
        assert.equal(JSON.parse(decryptSecret(credential.ciphertext, "feed:8101")).password === password, true);
        assert.equal(await verifyPassword(password, (await root.query("SELECT password_hash FROM owner WHERE id=1")).rows[0].password_hash), true);
        const ledger = (await root.query("SELECT * FROM fever_schema_migrations ORDER BY version")).rows;
        const repeat = cli(rootUrl.toString(), rootFingerprint, "scripts/migrate.ts", "apply");
        assert.deepEqual((await root.query("SELECT * FROM fever_schema_migrations ORDER BY version")).rows, ledger);
        assert.deepEqual(await inventory(root), after);
        const finalStatus = cli(rootUrl.toString(), rootFingerprint, "scripts/migrate.ts", "status"); assert.equal(finalStatus.result.applied, 2); assert.deepEqual(finalStatus.result.pending, []);
        await receipt("v1-upgrade", { targetFingerprint: rootFingerprint, status, applied, repeat, finalStatus, index, before, after, allContentAndSequencesConserved: true, passwordAndEncryptedCredentialVerified: true, navigationCountsVerified: true, repeatLedgerTimestampsUnchanged: true });
      } catch (error) {
        await writeFile(`${privateDir}/schema2-upgrade-error-${Date.now()}.txt`, inspect(error, { depth: 5 }), { flag: "wx", mode: 0o600 });
        throw error;
      } finally {
        if (seeding) await root.query("ROLLBACK");
        if (ownsOwner) await root.query("DELETE FROM owner WHERE id=1 AND email=$1", [email]);
      }
    });
    if (phase === "all" || phase === "fresh") await t.test("fresh empty database receives both reviewed migrations", async () => {
      const target = await sibling(root, "fever_schema2_fresh_20261024");
      try {
        const status = cli(target.url, target.fingerprint, "scripts/migrate.ts", "status"); assert.equal(status.result.applied, 0); assert.equal(status.result.pending.length, 2);
        const applied = cli(target.url, target.fingerprint, "scripts/migrate.ts", "apply"); await assertSchema(target.client);
        const index = await verifyIndex(target.client); const ledger = (await target.client.query("SELECT * FROM fever_schema_migrations ORDER BY version")).rows;
        assert.deepEqual(ledger.map(x => x.version), [1, 2]);
        const repeat = cli(target.url, target.fingerprint, "scripts/migrate.ts", "apply"); assert.deepEqual((await target.client.query("SELECT * FROM fever_schema_migrations ORDER BY version")).rows, ledger);
        await receipt("fresh-install", { database: target.database, targetFingerprint: target.fingerprint, status, applied, repeat, index, ledger, schemaVersion: 2, setupRemainsUninitialized: (await target.client.query("SELECT status FROM installation WHERE id=1")).rows[0].status === "uninitialized" });
      } finally { await closeTarget(target.client); }
    });
    if (phase === "all" || phase === "restore-v1") await t.test("retained v1 backup stays in maintenance then upgrades without data loss", async () => {
      const target = await sibling(root, "fever_schema1_restore_20261024");
      try {
        const manifest = JSON.parse(await readFile(`${privateDir}/source-v2.dump.manifest.json`, "utf8")); assert.equal(manifest.schemaVersion, 1);
        const restored = cli(target.url, target.fingerprint, "cli/ops.ts", "restore", ["--archive", `${privateDir}/source-v2.dump`, "--archive-manifest", `${privateDir}/source-v2.dump.manifest.json`, "--archive-sha256", manifest.archiveSha256]);
        assert.equal(restored.result.requiresMigration, true); assert.equal(restored.result.restoredSchemaVersion, 1); assert.equal(restored.result.releaseSchemaVersion, 2);
        assert.deepEqual((await target.client.query("SELECT schema_version,status,setup_closed FROM installation WHERE id=1")).rows, [{ schema_version: 1, status: "maintenance", setup_closed: true }]);
        await assert.rejects(assertSchema(target.client), /schema version/);
        const before = await inventory(target.client);
        const old = JSON.parse(await readFile(`${privateDir}/frozen-inventory.json`, "utf8"));
        // The retained source inventory uses a separate canonical JSON encoding.
        // Cross-check every restored raw row using that original encoding too.
        const originalTables: Record<string, { rows: number; sha256: string }> = {};
        const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
        for (const table of Object.keys(old.tables)) {
          assert.match(table, /^[a-z_]+$/);
          const rows = (await target.client.query(`SELECT to_jsonb(t) AS row FROM "${table}" t`)).rows.map(({ row }) => {
            if (table === "installation") { delete row.updated_at; delete row.migration_provenance.operatorBackup; delete row.migration_provenance.operatorRestore; }
            return stable(row);
          }).sort(); originalTables[table] = { rows: rows.length, sha256: createHash("sha256").update(stable(rows)).digest("hex") };
        }
        assert.deepEqual(originalTables, old.tables);
        const status = cli(target.url, target.fingerprint, "scripts/migrate.ts", "status"); assert.deepEqual(status.result.pending, ["0001_items_feed_navigation.sql"]);
        const upgrade = cli(target.url, target.fingerprint, "scripts/migrate.ts", "apply"); await assertSchema(target.client);
        const after = await inventory(target.client); conserved(before, after); const index = await verifyIndex(target.client);
        assert.equal((await target.client.query("SELECT status FROM installation WHERE id=1")).rows[0].status, "maintenance");
        const keys = cli(target.url, target.fingerprint, "cli/ops.ts", "check-keys"); assert.equal(keys.result.encryptedRecordsChecked, 4);
        const secrets = JSON.parse(await readFile(`${privateDir}/fixture-secrets.json`, "utf8"));
        const account = (await target.client.query("SELECT email,password_hash FROM owner WHERE id=1")).rows[0];
        assert.equal(await verifyPassword(secrets.password, account.password_hash), true);
        assert.equal((await target.client.query("SELECT verifier FROM fever_credentials WHERE owner_id=1")).rows[0].verifier === feverDigestVerifier(account.email, secrets.password), true);
        assert.equal(JSON.parse(decryptSecret((await target.client.query("SELECT ciphertext FROM feed_credentials WHERE feed_id=2002")).rows[0].ciphertext, "feed:2002")).password === secrets.feedPassword, true);
        const repeat = cli(target.url, target.fingerprint, "scripts/migrate.ts", "apply"); assert.deepEqual(await inventory(target.client), after);
        await receipt("v1-backup-continuity", { database: target.database, targetFingerprint: target.fingerprint, archiveSha256: manifest.archiveSha256, restored, status, upgrade, repeat, index, before, after, original28TableDigestsMatch: true, allContentAndSequencesConserved: true, checkedEncryptedRecords: 4, ownerPasswordFeverVerifierAndFeedCredentialVerified: true, maintenanceLatchRetained: true, noActivationPerformed: true });
      } finally { await closeTarget(target.client); }
    });
    if (phase !== "verify") await receipt(`cleanup-${phase}-${Date.now()}`, { owners: (await root.query("SELECT count(*)::int AS n FROM owner")).rows[0].n, installation: (await root.query("SELECT schema_version,status FROM installation WHERE id=1")).rows[0], branch: "br-wild-mountain-arbkcgd9", noMainApply: true });
  } finally { await closeTarget(root); await closeDatabase(); }
});

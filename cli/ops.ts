import { readFile, stat } from "node:fs/promises";
import { argumentsFor, confirmation, environment, loadExplicitEnvironment, required, safeFailure } from "./common";
import { backup, restore, type BackupManifest } from "./postgres-tools";
import { getConfig, SCHEMA_VERSION } from "../lib/config";
import { decryptSecret } from "../lib/crypto";
import { closeDatabase } from "../lib/db/client";
import { issueRecoveryToken } from "../lib/auth/recovery";
import { fileDigest, inputFile, writeRestrictedJson } from "../lib/migration/files";
import { assertSchema, assertTarget, closeTarget, connectTarget, lockTarget, reconcileSequences, targetFingerprint } from "../lib/migration/target";
import { digest, inspectSnapshot } from "../lib/migration/snapshot";
import { freezeRecord, mysqlSource } from "../lib/migration/sources";
import { applyLegacyRollback, exportLegacyRollback, type ReplayManifest } from "../lib/migration/rollback";

async function readJson(path: string, limit = 2 * 1024 * 1024): Promise<unknown> {
  const safe = await inputFile(path); if ((await stat(safe)).size > limit) throw new Error("Operator JSON exceeds its size limit"); return JSON.parse(await readFile(safe, "utf8"));
}
async function main() {
  const { values, positionals } = argumentsFor(["env-file", "target-url-env", "target-fingerprint", "confirm", "output", "archive", "archive-manifest", "archive-sha256", "minutes", "evidence", "baseline", "replay", "replay-manifest", "password-file", "disable-saved-rss", "prefix", "frozen-at", "freeze-evidence", "issue-after"]);
  await loadExplicitEnvironment(values["env-file"]);
  const command = positionals[0];
  if (command === "inspect-mysql" || command === "rollback-apply") {
    const url = environment(required(values, "target-url-env"));
    const prefix = required(values, "prefix"); const freeze = freezeRecord(required(values, "frozen-at"), required(values, "freeze-evidence"));
    if (command === "inspect-mysql") {
      const source = await mysqlSource(url, prefix, freeze);
      try { const endpoint = new URL(url); const identity = { host: endpoint.hostname, port: endpoint.port || "3306", database: source.header.metadata.database, prefix, version: source.header.metadata.version }; console.log(JSON.stringify({ identity, fingerprint: digest(identity) })); } finally { await source.close(); } return;
    }
    const fingerprint = required(values, "target-fingerprint"); confirmation(values, "rollback", fingerprint);
    const baseline = await inspectSnapshot(required(values, "baseline")); const replay = await inspectSnapshot(required(values, "replay"));
    const manifest = await readJson(required(values, "replay-manifest")) as ReplayManifest;
    if (manifest.format !== 1 || !manifest.credentialVerified || manifest.baselineFingerprint !== baseline.footer.fingerprint || manifest.finalFingerprint !== replay.footer.fingerprint) throw new Error("Replay manifest is not bound to these snapshots");
    console.log(JSON.stringify(await applyLegacyRollback(url, prefix, baseline, replay, fingerprint, freeze))); return;
  }
  const url = environment(required(values, "target-url-env")); process.env.DATABASE_URL = url;
  const client = await connectTarget(url);
  try {
    if (command === "inspect-target") { console.log(JSON.stringify(await targetFingerprint(client, url), null, 2)); return; }
    const fingerprint = required(values, "target-fingerprint"); await assertTarget(client, url, fingerprint);
    if (command === "status") {
      await assertSchema(client);
      const installation = (await client.query("SELECT schema_version,status,setup_closed,source_version,migration_provenance->'operatorBackup' AS backup,migration_provenance->'operatorRestore' AS restore FROM installation WHERE id=1")).rows[0];
      const runs = (await client.query("SELECT id,source_kind,source_fingerprint,status,stage,checkpoints,counts FROM migration_runs ORDER BY id")).rows;
      const after = values["issue-after"] ?? "0"; if (!/^(?:0|[1-9]\d{0,15})$/.test(after)) throw new Error("Invalid issue cursor");
      const issues = (await client.query("SELECT id::text AS id,source_table,source_id,disposition,details->'issues' AS issues FROM migration_issues WHERE id>$1::bigint AND (disposition='quarantined' OR (code='SOURCE_ARCHIVE' AND jsonb_array_length(COALESCE(details->'issues','[]'::jsonb))>0)) ORDER BY id LIMIT 1000", [after])).rows;
      console.log(JSON.stringify({ targetFingerprint: fingerprint, installation, runs, issues, nextIssueAfter: issues.length === 1000 ? issues[issues.length - 1].id : null })); return;
    }
    confirmation(values, command, fingerprint); await lockTarget(client);
    if (command === "backup") { console.log(JSON.stringify(await backup(client, url, required(values, "output")))); return; }
    if (command === "restore") {
      const manifest = await readJson(required(values, "archive-manifest")) as BackupManifest;
      console.log(JSON.stringify(await restore(client, url, required(values, "archive"), manifest, required(values, "archive-sha256")))); return;
    }
    await assertSchema(client);
    if (command === "quiesce") {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('fever:installation',0))");
        await client.query("UPDATE installation SET status='maintenance',updated_at=now() WHERE id=1");
        await client.query("UPDATE refresh_jobs SET status='cancelled',cancel_requested_at=now(),finished_at=now(),fence=fence+1,lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('queued','running')");
        await client.query("UPDATE feed_fetch_state SET fence=fence+1,lease_owner=NULL,lease_expires_at=NULL WHERE lease_owner IS NOT NULL");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      console.log(JSON.stringify({ ok: true, status: "maintenance", next: "Stop worker supervision before backup, import, or rollback." })); return;
    }
    if (command === "activate") {
      const path = required(values, "evidence"); const evidence = await readJson(path) as Record<string, unknown>;
      if (evidence.targetFingerprint !== fingerprint || evidence.schemaVersion !== SCHEMA_VERSION || evidence.approved !== true || evidence.rehearsalPassed !== true || !/^[a-f0-9]{64}$/.test(String(evidence.artifactDigest)) || !Array.isArray(evidence.acceptedIssueIds)) throw new Error("Activation requires reviewed exact-target, artifact, schema, rehearsal, and issue-disposition evidence");
      const run = (await client.query("SELECT * FROM migration_runs ORDER BY id DESC LIMIT 1")).rows[0];
      if (run && (run.status !== "completed" || evidence.sourceFingerprint !== run.source_fingerprint)) throw new Error("Activation evidence does not match a completed source import");
      const unresolved = (await client.query("SELECT id::text AS id FROM migration_issues WHERE disposition='quarantined' OR (code='SOURCE_ARCHIVE' AND jsonb_array_length(COALESCE(details->'issues','[]'::jsonb))>0)")).rows.map(row => row.id);
      if (unresolved.some(id => !(evidence.acceptedIssueIds as unknown[]).includes(id))) throw new Error("Every quarantined source row needs an explicit disposition in activation evidence");
      if (!(await client.query("SELECT EXISTS(SELECT 1 FROM owner WHERE id=1) AS found")).rows[0].found) throw new Error("Activation requires an initialized owner");
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('fever:installation',0))");
        await client.query("UPDATE installation SET status='ready',migration_provenance=jsonb_set(migration_provenance,'{activation}',$1::jsonb),updated_at=now() WHERE id=1", [JSON.stringify({ evidenceSha256: await fileDigest(path), activatedAt: new Date().toISOString(), artifactDigest: evidence.artifactDigest })]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      console.log(JSON.stringify({ ok: true, status: "ready", targetFingerprint: fingerprint })); return;
    }
    if (command === "recover-owner") {
      const result = await issueRecoveryToken(values.minutes ? { ttlMinutes: Number(values.minutes) } : undefined);
      const base = getConfig().baseUrl; if (!base) throw new Error("Canonical FEVER_BASE_URL is required");
      // Deliberately output this one newly issued credential exactly once.
      console.log(JSON.stringify({ recoveryUrl: `${base}/recovery#token=${encodeURIComponent(result.token)}`, token: result.token, expiresAt: result.expiresAt.toISOString() })); return;
    }
    if (command === "check-keys") {
      let checked = 0;
      const credentials = await client.query("SELECT feed_id,ciphertext FROM feed_credentials ORDER BY feed_id");
      for (const row of credentials.rows) { JSON.parse(decryptSecret(row.ciphertext, `feed:${row.feed_id}`)); checked++; }
      const runs = await client.query("SELECT source_fingerprint,manifest FROM migration_runs");
      for (const row of runs.rows) { if (row.manifest.keyCheck && decryptSecret(row.manifest.keyCheck, `migration:${row.source_fingerprint}`) !== row.source_fingerprint) throw new Error("Migration key verification failed"); checked++; }
      for (let offset = 0; ; offset += 100) {
        const archives = await client.query("SELECT raw_data,raw_data_hash,details FROM migration_issues WHERE code='SOURCE_ARCHIVE' AND encrypted ORDER BY id LIMIT 100 OFFSET $1", [offset]);
        for (const row of archives.rows) {
          const original = JSON.parse(decryptSecret((row.raw_data as Buffer).toString("utf8"), row.details.context));
          if (digest(original) !== row.raw_data_hash) throw new Error("Archived source row decryption or integrity failed"); checked++;
        }
        if (archives.rows.length < 100) break;
      }
      const maintenance = await client.query("SELECT operation,ciphertext,owner_id FROM maintenance_backups");
      for (const row of maintenance.rows) { JSON.parse(decryptSecret(row.ciphertext, `maintenance:${row.owner_id}:${row.operation}`)); checked++; }
      console.log(JSON.stringify({ ok: true, encryptedRecordsChecked: checked })); return;
    }
    if (command === "export-keys") {
      const config = getConfig();
      if (!config.authSecret || !config.encryptionKeys[config.encryptionKeyId]) throw new Error("Complete current key material is required");
      await writeRestrictedJson(required(values, "output"), { format: 1, exportedAt: new Date().toISOString(), targetFingerprint: fingerprint, FEVER_ENCRYPTION_KEY_ID: config.encryptionKeyId, FEVER_ENCRYPTION_KEYS: config.encryptionKeys, NEXTAUTH_SECRET: config.authSecret });
      console.log(JSON.stringify({ ok: true, message: "Private key recovery file written. Store separately from database archives on encrypted offline storage." })); return;
    }
    if (command === "reconcile-sequences") {
      if ((await client.query("SELECT status FROM installation WHERE id=1")).rows[0].status !== "maintenance") throw new Error("Sequence reconciliation requires maintenance status and stopped workers");
      console.log(JSON.stringify({ ok: true, sequences: await reconcileSequences(client) })); return;
    }
    if (command === "rollback-export") {
      const baseline = await inspectSnapshot(required(values, "baseline"));
      const result = await exportLegacyRollback(client, baseline, required(values, "output"), fingerprint, { passwordFile: values["password-file"], disableSavedRss: values["disable-saved-rss"] === "confirmed" });
      console.log(JSON.stringify(result)); return;
    }
    throw new Error("Unknown operator command");
  } finally { await closeTarget(client); await closeDatabase(); }
}
main().catch(safeFailure);

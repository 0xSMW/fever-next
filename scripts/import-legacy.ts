import { argumentsFor, confirmation, environment, loadExplicitEnvironment, required, safeFailure } from "../cli/common";
import { extractSnapshot, inspectSnapshot } from "../lib/migration/snapshot";
import { freezeRecord, mysqlSource, sqliteSource } from "../lib/migration/sources";
import { analyzeSnapshot } from "../lib/migration/analyze";
import { writeRestrictedJson } from "../lib/migration/files";
import { closeTarget, connectTarget, targetFingerprint } from "../lib/migration/target";
import { importSnapshot } from "../lib/migration/importer";

async function main() {
  const { values, positionals } = argumentsFor(["env-file", "source-url-env", "source-path", "prefix", "output", "frozen-at", "freeze-evidence", "snapshot", "report", "target-url-env", "target-fingerprint", "source-fingerprint", "confirm", "base-url", "quarantine-confirm", "saved-rss-policy", "batch-size"]);
  await loadExplicitEnvironment(values["env-file"]);
  const command = positionals[0];
  if (command === "extract-mysql" || command === "extract-sqlite") {
    const freeze = freezeRecord(required(values, "frozen-at"), required(values, "freeze-evidence"));
    const source = command === "extract-mysql" ? await mysqlSource(environment(required(values, "source-url-env")), required(values, "prefix"), freeze) : await sqliteSource(required(values, "source-path"), freeze);
    const manifest = await extractSnapshot(source, required(values, "output"));
    console.log(JSON.stringify({ ok: true, fingerprint: manifest.fingerprint, tables: manifest.tables })); return;
  }
  if (command === "inspect-target") {
    const url = environment(required(values, "target-url-env")); const client = await connectTarget(url);
    try { console.log(JSON.stringify(await targetFingerprint(client, url), null, 2)); } finally { await closeTarget(client); } return;
  }
  if (command !== "dry-run" && command !== "apply") throw new Error("Use extract-mysql, extract-sqlite, inspect-target, dry-run, or apply");
  const snapshot = await inspectSnapshot(required(values, "snapshot"));
  const analysis = await analyzeSnapshot(snapshot);
  await writeRestrictedJson(required(values, "report"), { ...analysis.report, dispositions: [...analysis.dispositions.values()] });
  if (command === "dry-run") { console.log(JSON.stringify({ ok: analysis.report.readyToImport, sourceFingerprint: snapshot.footer.fingerprint, counts: analysis.report.counts, issues: analysis.report.issues.length, conservation: analysis.report.conservation })); return; }
  const url = environment(required(values, "target-url-env")); const fingerprint = required(values, "target-fingerprint");
  confirmation(values, "import", fingerprint);
  // All imported helpers read configuration lazily; explicitly bind them to this target.
  process.env.DATABASE_URL = url;
  const client = await connectTarget(url);
  try {
    const policy = values["saved-rss-policy"];
    if (policy !== undefined && policy !== "legacy" && policy !== "exclude-protected") throw new Error("Invalid Saved RSS migration policy");
    const result = await importSnapshot(client, snapshot, { targetUrl: url, targetFingerprint: fingerprint, sourceFingerprint: required(values, "source-fingerprint"), baseUrl: required(values, "base-url"), allowQuarantine: values["quarantine-confirm"], savedRssPolicy: policy, batchSize: values["batch-size"] ? Number(values["batch-size"]) : undefined }, analysis);
    console.log(JSON.stringify({ ok: true, runId: result.runId, status: result.status, sourceFingerprint: snapshot.footer.fingerprint }));
  } finally { await closeTarget(client); }
}
main().catch(safeFailure);

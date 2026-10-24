import { Client, type ClientConfig } from "pg";
import { getConfig, SCHEMA_VERSION, validateDatabaseUrl } from "../config";
import { digest } from "./snapshot";

export const MIGRATION_LOCK = "6919284026165081";
export function targetConfig(url: string): ClientConfig {
  validateDatabaseUrl(url);
  const config = getConfig({ ...process.env, DATABASE_URL: url });
  return { connectionString: url, ssl: config.databaseSsl, connectionTimeoutMillis: config.databaseConnectionTimeoutMs, statement_timeout: 120_000, lock_timeout: config.databaseLockTimeoutMs, application_name: "fever-operator" };
}
export async function connectTarget(url: string): Promise<Client> {
  const client = new Client(targetConfig(url));
  // pg rejects pending queries separately. An idle socket error must not escape
  // as an unhandled EventEmitter error containing raw provider diagnostics.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("SET search_path TO public, pg_catalog");
    return client;
  } catch (error) {
    // Failed handshakes can still own a socket. Preserve the original failure
    // for the caller's redaction boundary even if cleanup also fails.
    try { await closeTarget(client); } catch { /* Cleanup must not replace the cause. */ }
    throw error;
  }
}
interface OperatorConnectionState {
  _getActiveQuery(): unknown;
  _queryQueue: unknown[];
  _sentQueryQueue: unknown[];
  connection: { stream: { destroy(): void } };
}
/** Call only after COMMIT/ROLLBACK and after every query has settled. */
export async function closeTarget(client: Client, timeoutMs = 2_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid operator close timeout");
  // pg's pinned driver exposes the transaction status publicly; its internal
  // queues additionally distinguish an idle session from an in-flight SELECT.
  const state = client as unknown as OperatorConnectionState;
  const assertIdle = () => {
    if (["T", "E"].includes(client.getTransactionStatus() ?? "")) throw new Error("Commit or roll back the operator transaction before closing");
    if (state._getActiveQuery() || state._queryQueue.length || state._sentQueryQueue.length) throw new Error("Complete all operator queries before closing");
  };
  assertIdle();
  const ending = client.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ending, new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          assertIdle();
          // Some proxy/TLS sockets never deliver the graceful end event even
          // after PostgreSQL has removed the session. No work remains to flush.
          state.connection.stream.destroy();
          resolve();
        } catch (error) { reject(error); }
      }, timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
  // Promise.race retains handlers on `ending`, including a late rejection.
}
export async function targetFingerprint(client: Client, url: string): Promise<{ fingerprint: string; identity: Record<string, unknown> }> {
  const result = await client.query("SELECT current_database() AS database, d.oid::text AS database_oid, d.datcollate AS collation, d.datctype AS ctype, pg_encoding_to_char(d.encoding) AS encoding, (SELECT oid::text FROM pg_namespace WHERE nspname='public') AS schema_oid, current_setting('server_version_num') AS server_version FROM pg_database d WHERE d.datname=current_database()");
  const endpoint = new URL(url);
  const identity = { endpoint: `${endpoint.hostname}:${endpoint.port || "5432"}`, ...result.rows[0] };
  return { fingerprint: digest(identity), identity };
}
export async function assertTarget(client: Client, url: string, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(expected) || (await targetFingerprint(client, url)).fingerprint !== expected) throw new Error("Target fingerprint does not match the explicitly reviewed destination");
}
export async function assertSchema(client: Client) {
  const result = await client.query("SELECT schema_version FROM installation WHERE id=1");
  if (result.rowCount !== 1 || result.rows[0].schema_version !== SCHEMA_VERSION) throw new Error("Target schema version does not match this release; run reviewed migrations first");
}
export async function lockTarget(client: Client) {
  const result = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [MIGRATION_LOCK]);
  if (!result.rows[0].acquired) throw new Error("Another migration or operator change holds the target lock");
}
const identityTables = ["owner", "fever_credentials", "auth_recovery_tokens", "sharing_services", "favicons", "groups", "feeds", "items", "link_occurrences", "blacklist_rules", "refresh_jobs", "job_feed_results", "state_operations", "migration_runs", "migration_issues", "maintenance_backups", "maintenance_challenges", "ingest_quarantine"] as const;
/** Target writes must remain disabled. Never lower an already advanced sequence. */
export async function reconcileSequences(client: Client, reservedMaximums: Record<string, string | null> = {}): Promise<Record<string, { maxId: string; nextId: string }>> {
  const result: Record<string, { maxId: string; nextId: string }> = {};
  for (const table of identityTables) {
    const found = await client.query("SELECT pg_get_serial_sequence($1, 'id') AS name", [`public.${table}`]);
    const name: string | null = found.rows[0].name;
    if (!name || !/^(?:public\.)?[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unrecognized identity sequence for ${table}`);
    const maximum = await client.query(`SELECT COALESCE(MAX(id),0)::text AS maximum FROM "${table}"`);
    const state = await client.query(`SELECT last_value::text, is_called FROM ${name.split(".").map(part => `"${part}"`).join(".")}`);
    const storedMaximum = BigInt(maximum.rows[0].maximum);
    const reserved = reservedMaximums[table] ? BigInt(reservedMaximums[table]!) : 0n;
    const maxId = storedMaximum > reserved ? storedMaximum : reserved; const last = BigInt(state.rows[0].last_value);
    const next = state.rows[0].is_called ? last + 1n : last;
    const desired = maxId >= next ? maxId + 1n : next;
    if (desired > 9_007_199_254_740_991n) throw new Error(`Identity range exhausted in ${table}`);
    if (desired > next) await client.query("SELECT setval($1::regclass,$2::bigint,false)", [name, desired.toString()]);
    result[table] = { maxId: maxId.toString(), nextId: desired.toString() };
  }
  return result;
}
export async function insertRecord(client: Client, table: string, values: Record<string, unknown>): Promise<void> {
  if (!/^[a-z_]+$/.test(table) || Object.keys(values).some(column => !/^[a-z_]+$/.test(column))) throw new Error("Invalid internal import SQL identifier");
  const columns = Object.keys(values);
  await client.query(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`, Object.values(values));
}
export function snakeObject(value: object): Record<string, unknown> { return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), entry])); }

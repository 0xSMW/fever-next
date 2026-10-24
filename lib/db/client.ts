import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getConfig } from "../config";
import { databaseSchema } from "./schema";

export type Database = NodePgDatabase<typeof databaseSchema>;
type DatabaseState = { pool?: Pool; db?: Database };
const stateKey = Symbol.for("fever.postgresql.connection");
const globals = globalThis as typeof globalThis & { [stateKey]?: DatabaseState };
const state = globals[stateKey] ?? (globals[stateKey] = {});

/** One bounded pool per process, shared across development module reloads. */
export function getPool(): Pool {
  if (state.pool) return state.pool;
  const config = getConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
    ssl: config.databaseSsl,
    application_name: "fever-next",
    // Applies on every new physical connection, without async connect-event races.
    options: `-c timezone=UTC -c statement_timeout=${config.databaseStatementTimeoutMs} -c lock_timeout=${config.databaseLockTimeoutMs} -c idle_in_transaction_session_timeout=60000`,
  });
  // pg requires an idle-client error listener. Never include URLs, SQL, or credentials.
  pool.on("error", (error: Error & { code?: string }) => {
    const code = error.code && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "CONNECTION_ERROR";
    console.error(JSON.stringify({ event: "database.pool_error", code }));
  });
  state.pool = pool;
  return pool;
}

/** No connection or migration occurs until a caller performs a query. */
export function getDb(): Database {
  if (!state.db) state.db = drizzle(getPool(), { schema: databaseSchema });
  return state.db;
}

/** CLI/worker shutdown only: callers must first finish their in-flight work. */
export async function closeDatabase(): Promise<void> {
  const pool = state.pool;
  state.db = undefined;
  state.pool = undefined;
  if (pool) await pool.end();
}

// Raw pg queries retain bigint/numeric strings. Convert with ./numbers at boundaries;
// never install a global int8 parser, which would silently round oversized values.

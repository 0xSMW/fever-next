import { Pool, type PoolClient } from 'pg';
import { getConfig } from '../config';

// This pool holds session locks during HTTP only. Keeping it separate prevents a
// host slot from consuming the application connection needed to renew a lease.
let coordinator: Pool | undefined;
function coordinationPool(): Pool {
  if (coordinator) return coordinator;
  const config = getConfig();
  const hostname = new URL(config.databaseUrl).hostname;
  if (hostname.endsWith('.neon.tech') && hostname.includes('-pooler.')) throw new Error('Worker host limits require a session-preserving PostgreSQL connection.');
  coordinator = new Pool({
    connectionString: config.databaseUrl, ssl: config.databaseSsl,
    max: config.workerConcurrency, connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    idleTimeoutMillis: 1000, allowExitOnIdle: true,
    application_name: 'fever-host-coordinator',
    options: '-c statement_timeout=5000 -c lock_timeout=1000',
  });
  coordinator.on('error', () => { /* An idle connection owns no host locks. */ });
  return coordinator;
}
function cancelled(): Error { return new Error('Worker host coordination was cancelled.'); }
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function checkout(signal: AbortSignal): Promise<PoolClient> {
  if (signal.aborted) return Promise.reject(cancelled());
  const pool = coordinationPool();
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const abort = () => { abandoned = true; reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    pool.connect().then(client => {
      signal.removeEventListener('abort', abort);
      if (abandoned || signal.aborted) { client.release(); reject(cancelled()); }
      else resolve(client);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function acquire(client: PoolClient, keys: string[], signal: AbortSignal): Promise<string> {
  while (!signal.aborted) {
    for (const key of keys) {
      if (signal.aborted) throw cancelled();
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [key]);
      if (result.rows[0].acquired === true) return key;
    }
    await wait(50, signal);
  }
  throw cancelled();
}

/** Cross-worker per-host capacity and 500ms start spacing, without a transaction. */
export async function withWorkerHostSlot<T>(hostname: string, signal: AbortSignal, abortRequest: () => void, operation: () => Promise<T>): Promise<T> {
  const host = hostname.toLowerCase();
  const client = await checkout(signal);
  let connectionError: Error | undefined;
  const failed = (error: Error) => { connectionError = error; abortRequest(); };
  client.on('error', failed);
  try {
    const capacity = getConfig().perHostConcurrency;
    await acquire(client, Array.from({ length: capacity }, (_, index) => `fever:http:host:${host}:slot:${index}`), signal);
    const rateKey = await acquire(client, [`fever:http:host:${host}:start`], signal);
    if (signal.aborted) throw cancelled();
    // Release the start lock after a bounded interval while the request can keep
    // its capacity slot. Even a fast response retains the full start interval.
    const releaseStart = new Promise<void>(resolve => setTimeout(resolve, 500)).then(async () => {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [rateKey]);
    });
    void releaseStart.catch(error => { connectionError = error instanceof Error ? error : new Error('Worker host coordination failed.'); abortRequest(); });
    try { return await operation(); }
    finally { await releaseStart; }
  } finally {
    let cleanupError: Error | undefined;
    try { if (!connectionError) await client.query('SELECT pg_advisory_unlock_all()'); }
    catch (error) { cleanupError = error instanceof Error ? error : new Error('Worker host coordination cleanup failed.'); }
    finally { client.removeListener('error', failed); client.release(connectionError ?? cleanupError); }
    if (connectionError) throw connectionError;
    if (cleanupError) throw cleanupError;
  }
}
/** Supervised-worker shutdown only; web batches keep their shared pools open. */
export async function closeHostCoordinator(): Promise<void> {
  const pool = coordinator;
  coordinator = undefined;
  if (pool) await pool.end();
}

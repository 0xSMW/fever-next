export const SCHEMA_VERSION = 2;
export const CONTENT_POLICY_VERSION = 1;
export const IDENTITY_VERSION = 1;
export const RANKING_VERSION = 1;
export const NORMALIZATION_VERSION = 1;
export const DEFAULT_OWNER_ID = 1;
export const DEFAULT_FAVICON_ID = 1;

export { defaultPreferences, defaultViewState, DEFAULT_PREFERENCES, DEFAULT_VIEW_STATE, createDefaultPreferences, createDefaultViewState } from "./reader-policy";

export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}
type Environment = Readonly<Record<string, string | undefined>>;
function intEnv(env: Environment, name: string, fallback: number, min: number, max: number): number {
  const text = env[name];
  if (text == null || text === "") return fallback;
  if (!/^\d+$/.test(text)) throw new ConfigurationError(`${name} must be an integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigurationError(`${name} is out of range`);
  return value;
}
function boolEnv(env: Environment, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value == null || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ConfigurationError(`${name} must be true or false`);
}
export function validateDatabaseUrl(value: string | undefined): string {
  if (!value) throw new ConfigurationError("DATABASE_URL is required");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ConfigurationError("DATABASE_URL must be a PostgreSQL URL"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new ConfigurationError("DATABASE_URL must identify a PostgreSQL database");
  }
  // Connection-string ssl flags override pg's explicit TLS options. Configure TLS only below.
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl", "uselibpqcompat"]) {
    if (parsed.searchParams.has(name)) throw new ConfigurationError(`Configure database TLS with FEVER_DB_SSL, not DATABASE_URL ${name}`);
  }
  return value;
}
export function validateBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new ConfigurationError("FEVER_BASE_URL must be an absolute URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError("FEVER_BASE_URL must be an HTTP(S) origin and optional path");
  }
  return url.toString().replace(/\/$/, "");
}
export interface RuntimeConfig {
  databaseUrl: string; databasePoolMax: number; databaseConnectionTimeoutMs: number;
  databaseIdleTimeoutMs: number; databaseStatementTimeoutMs: number; databaseLockTimeoutMs: number;
  databaseSsl: false | { rejectUnauthorized: true; ca?: string };
  production: boolean; baseUrl?: string; basePath: string;
  authSecret?: string; setupToken?: string; sessionMaxAgeSeconds: number;
  encryptionKeyId: string; encryptionKeys: Readonly<Record<string, string>>;
  workerConcurrency: number; perHostConcurrency: number; workerPollMs: number;
  leaseSeconds: number; maxJobAttempts: number; fetchTimeoutMs: number;
  maxFeedBytes: number; maxMediaBytes: number; maxImportBytes: number;
  maxFeedItems: number; maxRedirects: number; allowPrivateFeeds: boolean;
  allowedPrivateOrigins: readonly string[]; retentionEnabled: boolean;
}
/** Lazy and side-effect-free: importing a module neither reads .env files nor connects. */
export function getConfig(env: Environment = process.env): RuntimeConfig {
  const production = env.NODE_ENV === "production";
  const databaseUrl = validateDatabaseUrl(env.DATABASE_URL);
  const baseUrl = validateBaseUrl(env.FEVER_BASE_URL);
  const basePath = baseUrl ? new URL(baseUrl).pathname.replace(/\/$/, "") : "";
  if (env.NEXTAUTH_URL && (!baseUrl || env.NEXTAUTH_URL.replace(/\/$/, "") !== `${baseUrl}/api/auth`)) {
    throw new ConfigurationError("NEXTAUTH_URL must equal FEVER_BASE_URL followed by /api/auth");
  }
  if (env.NEXT_PUBLIC_BASE_PATH != null && env.NEXT_PUBLIC_BASE_PATH !== basePath) {
    throw new ConfigurationError("NEXT_PUBLIC_BASE_PATH must equal the path in FEVER_BASE_URL");
  }
  const authSecret = env.NEXTAUTH_SECRET;
  if (authSecret && Buffer.byteLength(authSecret) < 32) throw new ConfigurationError("Authentication secret must contain at least 32 bytes");
  const encryptionKeyId = env.FEVER_ENCRYPTION_KEY_ID ?? "primary";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(encryptionKeyId)) throw new ConfigurationError("Invalid FEVER_ENCRYPTION_KEY_ID");
  let encryptionKeys: Record<string, string> = Object.create(null) as Record<string, string>;
  if (env.FEVER_ENCRYPTION_KEYS) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.FEVER_ENCRYPTION_KEYS); } catch { throw new ConfigurationError("FEVER_ENCRYPTION_KEYS must be a JSON key map"); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new ConfigurationError("FEVER_ENCRYPTION_KEYS must be a JSON key map");
    for (const [id, key] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32) {
        throw new ConfigurationError("Encryption keys must be named, base64-encoded 32-byte values");
      }
      encryptionKeys[id] = key;
    }
  }
  if (env.FEVER_ENCRYPTION_KEY) {
    const key = env.FEVER_ENCRYPTION_KEY;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32) throw new ConfigurationError("FEVER_ENCRYPTION_KEY must encode exactly 32 bytes as base64");
    encryptionKeys = { ...encryptionKeys, [encryptionKeyId]: key };
  }
  const allowedPrivateOrigins = (env.FEVER_ALLOWED_PRIVATE_ORIGINS ?? "").split(",").filter(Boolean).map((entry) => {
    let parsed: URL;
    try { parsed = new URL(entry.trim()); } catch { throw new ConfigurationError("Invalid private-feed origin allowlist entry"); }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new ConfigurationError("Private-feed allowlist entries must be exact HTTP(S) origins");
    }
    return parsed.origin;
  });
  return {
    databaseUrl,
    databasePoolMax: intEnv(env, "FEVER_DB_POOL_MAX", 10, 1, 100),
    databaseConnectionTimeoutMs: intEnv(env, "FEVER_DB_CONNECT_TIMEOUT_MS", 10_000, 100, 120_000),
    databaseIdleTimeoutMs: intEnv(env, "FEVER_DB_IDLE_TIMEOUT_MS", 30_000, 1_000, 600_000),
    databaseStatementTimeoutMs: intEnv(env, "FEVER_DB_STATEMENT_TIMEOUT_MS", 30_000, 1_000, 600_000),
    databaseLockTimeoutMs: intEnv(env, "FEVER_DB_LOCK_TIMEOUT_MS", 5_000, 100, 120_000),
    databaseSsl: boolEnv(env, "FEVER_DB_SSL", production) ? { rejectUnauthorized: true, ...(env.FEVER_DB_SSL_CA ? { ca: env.FEVER_DB_SSL_CA } : {}) } : false,
    production, baseUrl, basePath, authSecret, setupToken: env.FEVER_SETUP_TOKEN,
    sessionMaxAgeSeconds: intEnv(env, "FEVER_SESSION_MAX_AGE_SECONDS", 7 * 86_400, 300, 30 * 86_400),
    encryptionKeyId, encryptionKeys,
    workerConcurrency: intEnv(env, "FEVER_WORKER_CONCURRENCY", 4, 1, 32),
    perHostConcurrency: intEnv(env, "FEVER_PER_HOST_CONCURRENCY", 2, 1, 8),
    workerPollMs: intEnv(env, "FEVER_WORKER_POLL_MS", 5_000, 250, 60_000),
    leaseSeconds: intEnv(env, "FEVER_LEASE_SECONDS", 120, 30, 3_600),
    maxJobAttempts: intEnv(env, "FEVER_MAX_JOB_ATTEMPTS", 5, 1, 20),
    fetchTimeoutMs: intEnv(env, "FEVER_FETCH_TIMEOUT_MS", 20_000, 1_000, 60_000),
    maxFeedBytes: intEnv(env, "FEVER_MAX_FEED_BYTES", 8 * 1024 * 1024, 1024, 8 * 1024 * 1024),
    maxMediaBytes: intEnv(env, "FEVER_MAX_MEDIA_BYTES", 10 * 1024 * 1024, 1024, 10 * 1024 * 1024),
    maxImportBytes: intEnv(env, "FEVER_MAX_IMPORT_BYTES", 16 * 1024 * 1024, 1024, 128 * 1024 * 1024),
    maxFeedItems: intEnv(env, "FEVER_MAX_FEED_ITEMS", 100, 1, 100),
    maxRedirects: intEnv(env, "FEVER_MAX_REDIRECTS", 4, 0, 4),
    allowPrivateFeeds: allowedPrivateOrigins.length > 0,
    allowedPrivateOrigins,
    retentionEnabled: boolEnv(env, "FEVER_RETENTION_ENABLED", false),
  };
}
export function requireAuthSecret(): string {
  const secret = getConfig().authSecret;
  if (!secret) throw new ConfigurationError("NEXTAUTH_SECRET is required");
  return secret;
}

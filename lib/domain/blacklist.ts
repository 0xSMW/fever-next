import { RE2JS } from "re2js";
import type { PoolClient } from "pg";
import { legacyLower } from "../legacy-url";
import { getPool } from "../db/client";
import { safeInteger, toCount, toId } from "../db/numbers";
import { getCheckedSessionEpoch } from "../auth/owner";
import { DomainError } from "../validation";

export const BLACKLIST_VERSION = 1;
export const BLACKLIST_LIMITS = Object.freeze({ bytes: 65_536, rules: 512, patternBytes: 2_048, urlBytes: 65_536 });

export interface BlacklistRule {
  position: number;
  kind: "exact" | "domain" | "regex";
  raw: string;
  pattern: string;
  enabled: boolean;
  compiled: boolean;
  error: string | null;
}
export interface BlacklistIssue { position: number; raw: string; message: string; }
export interface CompiledBlacklist {
  readonly rules: readonly BlacklistRule[];
  readonly issues: readonly BlacklistIssue[];
  matches(url: string): boolean;
}

export class BlacklistValidationError extends Error {
  readonly code = "INVALID_BLACKLIST";
  readonly status = 422;
  constructor(readonly issues: readonly BlacklistIssue[]) {
    super(issues.map((issue) => `Rule ${issue.position + 1}: ${issue.message}`).join("; "));
    this.name = "BlacklistValidationError";
  }
}

/**
 * Original rules split on whitespace, not lines. A leading # means regex and
 * *all* # characters are removed, including an apparent trailing modifier's
 * delimiter. Imported PCRE unsupported by RE2 is retained with a visible issue,
 * never executed by the backtracking JS engine. New rules cannot save invalid.
 * domain: is an explicit modern rule; old generated domain regex stays regex.
 */
export function compileBlacklist(raw: string): CompiledBlacklist {
  if (Buffer.byteLength(raw, "utf8") > BLACKLIST_LIMITS.bytes) {
    throw new BlacklistValidationError([{ position: 0, raw: "", message: "Blacklist exceeds 64 KiB" }]);
  }
  const tokens = raw.split(/[\t\n\r\f\v ]+/).filter((token) => token !== "" && token !== "0");
  if (tokens.length > BLACKLIST_LIMITS.rules) {
    throw new BlacklistValidationError([{ position: BLACKLIST_LIMITS.rules, raw: "", message: "Blacklist exceeds 512 rules" }]);
  }
  const rules: BlacklistRule[] = [];
  const issues: BlacklistIssue[] = [];
  const matchers: Array<(url: string) => boolean> = [];
  tokens.forEach((token, position) => {
    const kind = token.startsWith("#") ? "regex" : token.startsWith("domain:") ? "domain" : "exact";
    const pattern = kind === "regex" ? token.replace(/#/g, "") : kind === "domain" ? token.slice(7) : token;
    const rule: BlacklistRule = { position, kind, raw: token, pattern, enabled: true, compiled: false, error: null };
    try {
      if (Buffer.byteLength(pattern, "utf8") > BLACKLIST_LIMITS.patternBytes) throw new Error("Rule exceeds 2 KiB");
      if (kind === "regex") {
        const regex = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
        matchers.push((url) => regex.matcher(url).find());
      } else if (kind === "domain") {
        const domain = legacyLower(pattern).replace(/\.$/, "");
        if (!domain || domain.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes("..")) {
          throw new Error("domain: requires a hostname without a scheme, path, port, or wildcard");
        }
        matchers.push((url) => {
          try {
            const parsed = new URL(url);
            const host = legacyLower(parsed.hostname).replace(/\.$/, "");
            return (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "feed:")
              && (host === domain || host.endsWith(`.${domain}`));
          } catch { return false; }
        });
      } else {
        const exact = legacyLower(pattern);
        // PCRE $ additionally accepts one terminal LF. Keep that source quirk.
        matchers.push((url) => legacyLower(url) === exact || (url.endsWith("\n") && legacyLower(url.slice(0, -1)) === exact));
      }
      rule.compiled = true;
    } catch (error) {
      rule.enabled = false;
      rule.error = error instanceof Error ? error.message : "Unsupported regular expression";
      issues.push({ position, raw: token, message: rule.error });
    }
    rules.push(rule);
  });
  return {
    rules,
    issues,
    matches(url) {
      if (Buffer.byteLength(url, "utf8") > BLACKLIST_LIMITS.urlBytes) {
        throw new RangeError("Occurrence URL exceeds the bounded blacklist input size");
      }
      return matchers.some((matcher) => matcher(url));
    },
  };
}

export function validateBlacklist(raw: string): CompiledBlacklist {
  const result = compileBlacklist(raw);
  if (result.issues.length) throw new BlacklistValidationError(result.issues);
  return result;
}

export function previewBlacklist(raw: string, urls: readonly string[]): {
  rules: readonly BlacklistRule[]; issues: readonly BlacklistIssue[]; matches: boolean[];
} {
  if (urls.length > 3_000) throw new RangeError("Blacklist preview is limited to 3,000 URLs");
  const compiled = compileBlacklist(raw);
  return { rules: compiled.rules, issues: compiled.issues, matches: urls.map((url) => compiled.matches(url)) };
}

/** Call only inside the same transaction that reads rules and inserts links. */
export async function acquireBlacklistReadLock(client: PoolClient, ownerId: number): Promise<void> {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new TypeError("Invalid owner ID");
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [`fever:blacklist:${ownerId}`]);
}

export interface BlacklistOwner { id: number; email: string; }
export interface BlacklistSaveResult { rules: string; ruleCount: number; matched: number; scanned: number; version: number; }
export interface BlacklistReapplyOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { scanned: number; matched: number }) => void;
}

async function beginBlacklistMutation(client: PoolClient, owner: BlacklistOwner): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('fever:installation', 0))");
  const installation = await client.query<{ status: string }>("SELECT status FROM installation WHERE id = 1");
  if (installation.rows[0]?.status !== "ready") throw new Error("The reader is unavailable during installation or maintenance");
  // Keep this lock until commit so logout-all/recovery cannot invalidate a
  // checked browser context between authorization and its blacklist writes.
  // Explicit API/worker contexts use their own authorization and have no epoch.
  const account = await client.query<{ id: string }>(
    `SELECT id FROM owner WHERE id = $1 AND email = $2 AND recovery_required = false
       AND ($3::bigint IS NULL OR auth_epoch = $3) FOR SHARE`,
    [owner.id, owner.email, getCheckedSessionEpoch(owner) ?? null],
  );
  if (!account.rows[0]) throw new DomainError("Authentication is required.", "UNAUTHORIZED", 401);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`fever:blacklist:${owner.id}`]);
}

async function reapplyInTransaction(client: PoolClient, ownerId: number, matcher: CompiledBlacklist, options: BlacklistReapplyOptions) {
  let lastId = 0;
  let scanned = 0;
  let matched = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const batch = await client.query<{ id: string; url: string; is_blacklisted: boolean }>(
      `SELECT l.id, l.url, l.is_blacklisted FROM link_occurrences l
       JOIN feeds f ON f.id = l.feed_id
       WHERE f.owner_id = $1 AND l.id > $2 ORDER BY l.id ASC LIMIT 3000`, [ownerId, lastId],
    );
    if (!batch.rows.length) break;
    const changedIds: number[] = [];
    const changedValues: boolean[] = [];
    for (const row of batch.rows) {
      const id = toId(row.id, "occurrence ID");
      const value = matcher.matches(row.url);
      if (value) matched += 1;
      if (value !== row.is_blacklisted) { changedIds.push(id); changedValues.push(value); }
      lastId = id;
      scanned += 1;
    }
    if (changedIds.length) {
      await client.query(
        `UPDATE link_occurrences AS l SET is_blacklisted = b.value
         FROM unnest($1::bigint[], $2::boolean[]) AS b(id, value)
         WHERE l.id = b.id AND EXISTS (SELECT 1 FROM feeds f WHERE f.id = l.feed_id AND f.owner_id = $3)`,
        [changedIds, changedValues, ownerId],
      );
    }
    options.onProgress?.({ scanned, matched });
  }
  return { scanned: toCount(scanned), matched: toCount(matched) };
}

/**
 * Preferences, parsed rules, existing occurrence flags, and mutation journal
 * commit together. Ingestion's shared lock prevents stale inserts racing the
 * keyset scan. Cancelling or any matcher failure rolls back the entire change.
 */
export async function saveBlacklist(owner: BlacklistOwner, raw: string, options: BlacklistReapplyOptions = {}): Promise<BlacklistSaveResult> {
  const ownerId = toId(owner.id, "owner ID");
  const compiled = validateBlacklist(raw);
  options.signal?.throwIfAborted();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await beginBlacklistMutation(client, owner);
    const preferences = await client.query<{ blacklist: string; version: number }>(
      `SELECT p.blacklist, p.version FROM reader_preferences p
       JOIN owner o ON o.id = p.owner_id
       WHERE o.id = $1 AND o.email = $2 FOR UPDATE OF p`, [ownerId, owner.email],
    );
    if (!preferences.rows[0]) throw new Error("Authenticated owner preferences were not found");
    const before = preferences.rows[0];
    const version = safeInteger(before.version, "preference version", 1, 2_147_483_646) + 1;
    await client.query("DELETE FROM blacklist_rules WHERE owner_id = $1", [ownerId]);
    for (const rule of compiled.rules) {
      await client.query(
        `INSERT INTO blacklist_rules (owner_id, position, kind, pattern, original_rule, enabled, status, error, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [ownerId, rule.position, rule.kind, rule.pattern, rule.raw, rule.enabled, rule.compiled ? "valid" : "rejected", rule.error, BLACKLIST_VERSION],
      );
    }
    const counts = await reapplyInTransaction(client, ownerId, compiled, options);
    await client.query("UPDATE reader_preferences SET blacklist = $2, version = $3, updated_at = now() WHERE owner_id = $1", [ownerId, raw, version]);
    await client.query(
      `INSERT INTO state_operations (owner_id, origin, action, "before", "after") VALUES ($1,'owner','blacklist.save',$2::jsonb,$3::jsonb)`,
      [ownerId, JSON.stringify({ blacklist: before.blacklist, version: before.version }), JSON.stringify({ blacklist: raw, version, ...counts })],
    );
    options.signal?.throwIfAborted();
    await client.query("COMMIT");
    return { rules: raw, ruleCount: compiled.rules.length, ...counts, version };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Reapply the owner's current rules without an intermediate clear-all state. */
export async function reapplyBlacklist(owner: BlacklistOwner, options: BlacklistReapplyOptions = {}): Promise<{ scanned: number; matched: number }> {
  const ownerId = toId(owner.id, "owner ID");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await beginBlacklistMutation(client, owner);
    const result = await client.query<{ blacklist: string }>(
      `SELECT p.blacklist FROM reader_preferences p JOIN owner o ON o.id = p.owner_id WHERE o.id = $1 AND o.email = $2`, [ownerId, owner.email],
    );
    if (!result.rows[0]) throw new Error("Authenticated owner preferences were not found");
    const counts = await reapplyInTransaction(client, ownerId, validateBlacklist(result.rows[0].blacklist), options);
    options.signal?.throwIfAborted();
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

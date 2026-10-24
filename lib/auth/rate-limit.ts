import { createHmac } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { authRateLimits } from "@/lib/db/schema";
import { AuthError } from "./errors";
import { getAuthRuntime } from "./runtime";

export type AuthRateLimitScope = "login" | "setup" | "recovery" | "account" | "fever";
const limits: Record<AuthRateLimitScope, { count: number; seconds: number }> = {
  login: { count: 12, seconds: 60 },
  setup: { count: 5, seconds: 60 },
  recovery: { count: 8, seconds: 60 },
  account: { count: 10, seconds: 60 },
  fever: { count: 1200, seconds: 60 },
};

/**
 * PostgreSQL atomically increments a fixed installation-wide bucket. This works
 * across web processes and deliberately does not trust spoofable forwarded IPs.
 * Only five fixed subjects exist; user-supplied emails cannot grow this table.
 */
export async function consumeRateLimit(scope: AuthRateLimitScope): Promise<void> {
  const rule = limits[scope];
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (rule.seconds * 1000)) * rule.seconds * 1000);
  const end = new Date(windowStart.getTime() + rule.seconds * 1000);
  const subjectHash = createHmac("sha256", getAuthRuntime().secret)
    .update(`fever-auth-rate-v1\0${scope}`).digest("hex");
  const [bucket] = await getDb().insert(authRateLimits).values({
    subjectHash, windowStart, count: 1, expiresAt: new Date(end.getTime() + 86_400_000),
  }).onConflictDoUpdate({
    target: [authRateLimits.subjectHash, authRateLimits.windowStart],
    set: {
      count: sql`least(${authRateLimits.count} + 1, ${rule.count + 1})`,
      blockedUntil: sql`case when ${authRateLimits.count} >= ${rule.count} then ${end}::timestamptz else ${authRateLimits.blockedUntil} end`,
    },
  }).returning({ count: authRateLimits.count });
  if (bucket.count > rule.count) {
    throw new AuthError("Too many attempts. Wait briefly and try again.", 429, "RATE_LIMITED", Math.max(1, Math.ceil((end.getTime() - now) / 1000)));
  }
}

/** Called by operator/worker housekeeping; rows contain only keyed subjects and counts. */
export async function pruneAuthRateLimits(): Promise<void> {
  await getDb().delete(authRateLimits).where(lt(authRateLimits.expiresAt, new Date()));
}

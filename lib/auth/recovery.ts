import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { authRecoveryTokens, installation, owners, stateOperations } from "@/lib/db/schema";
import { rotateCredentials } from "./account";
import { AuthError, invalidInput } from "./errors";
import { feverDigestVerifier } from "./fever";
import { hashPassword, validateNewPassword, verifyPassword } from "./password";
import { consumeRateLimit } from "./rate-limit";
import { validateKeys } from "./security";

function tokenHash(token: string): string {
  return createHash("sha256").update(`fever-password-recovery-v1\0${token}`).digest("hex");
}

/** Local operator tooling only. Never expose this issuer through a web route. */
export async function issueRecoveryToken(options: { ttlMinutes?: number } = {}): Promise<{ token: string; expiresAt: Date }> {
  const ttl = options.ttlMinutes ?? 15;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 30) throw new Error("Recovery lifetime must be between 1 and 30 minutes.");
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 60_000);
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('fever:installation', 0))`);
    const [owner] = await tx.select({ id: owners.id, authEpoch: owners.authEpoch }).from(owners)
      .where(eq(owners.id, 1)).for("update");
    const [state] = await tx.select({ status: installation.status }).from(installation).where(eq(installation.id, 1));
    if (!owner || state?.status !== "ready") throw new Error("Recovery requires an initialized, active installation.");
    await tx.update(authRecoveryTokens).set({ usedAt: now })
      .where(and(eq(authRecoveryTokens.ownerId, owner.id), isNull(authRecoveryTokens.usedAt)));
    await tx.insert(authRecoveryTokens).values({
      ownerId: owner.id, tokenHash: tokenHash(token), purpose: "password-reset", authEpoch: owner.authEpoch,
      createdAt: now, expiresAt,
    });
    await tx.insert(stateOperations).values({
      ownerId: owner.id, origin: "operator", action: "auth.recovery-issued", affectedIds: [owner.id],
      after: { authEpoch: owner.authEpoch, expiresAt: expiresAt.toISOString() },
    });
  });
  return { token, expiresAt };
}

function invalidRecovery(): never {
  throw new AuthError("This recovery token is invalid, expired, or already used. Ask the operator for a new token.", 400, "INVALID_RECOVERY_TOKEN", undefined, { token: "Request a new recovery token." });
}

export async function recoverPassword(payload: Record<string, unknown>): Promise<{ ok: true; reauthenticate: true }> {
  validateKeys(payload, ["token", "password"]);
  await consumeRateLimit("recovery");
  if (typeof payload.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.token)) invalidRecovery();
  try { validateNewPassword(payload.password); } catch (error) { invalidInput((error as Error).message, "password"); }
  const hash = tokenHash(payload.token);
  const [candidate] = await getDb().select({
    tokenId: authRecoveryTokens.id, ownerId: owners.id, email: owners.email, emailKey: owners.emailKey,
    passwordHash: owners.passwordHash, authEpoch: owners.authEpoch,
  }).from(authRecoveryTokens).innerJoin(owners, eq(authRecoveryTokens.ownerId, owners.id))
    .innerJoin(installation, eq(installation.id, 1))
    .where(and(eq(authRecoveryTokens.tokenHash, hash), eq(authRecoveryTokens.purpose, "password-reset"),
      eq(authRecoveryTokens.authEpoch, owners.authEpoch), isNull(authRecoveryTokens.usedAt),
      gt(authRecoveryTokens.expiresAt, new Date()), eq(installation.status, "ready"))).limit(1);
  if (!candidate) invalidRecovery();
  // The protocol digest is deterministic; reusing the old password would preserve a stolen API key.
  if (await verifyPassword(payload.password, candidate.passwordHash)) invalidInput("Choose a different password so the previous password and API credential are revoked.", "password");
  const passwordHash = await hashPassword(payload.password);
  const verifier = feverDigestVerifier(candidate.email, payload.password);
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('fever:installation', 0))`);
    const [owner] = await tx.select({ id: owners.id, authEpoch: owners.authEpoch }).from(owners)
      .where(eq(owners.id, candidate.ownerId)).for("update");
    const [state] = await tx.select({ status: installation.status }).from(installation).where(eq(installation.id, 1));
    if (!owner || owner.authEpoch !== candidate.authEpoch || state?.status !== "ready") invalidRecovery();
    const consumed = await tx.update(authRecoveryTokens).set({ usedAt: new Date() })
      .where(and(eq(authRecoveryTokens.id, candidate.tokenId), eq(authRecoveryTokens.authEpoch, owner.authEpoch),
        isNull(authRecoveryTokens.usedAt), gt(authRecoveryTokens.expiresAt, new Date())))
      .returning({ id: authRecoveryTokens.id });
    if (!consumed.length) invalidRecovery();
    await rotateCredentials(tx, owner, candidate.email, candidate.emailKey, passwordHash, verifier, "recovery");
  });
  return { ok: true, reauthenticate: true };
}

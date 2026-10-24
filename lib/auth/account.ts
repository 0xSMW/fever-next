import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { authRecoveryTokens, feverCredentials, installation, owners, stateOperations } from "@/lib/db/schema";
import { AuthError, invalidInput } from "./errors";
import { feverDigestVerifier } from "./fever";
import { assertOwner, type OwnerContext } from "./owner";
import { hashPassword, passwordHasSupportedSize, validateNewPassword, verifyPassword } from "./password";
import { consumeRateLimit } from "./rate-limit";
import { validateNewEmail, validateKeys } from "./security";

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** Caller holds the owner row lock, has verified the old epoch, and owns the transaction. */
export async function rotateCredentials(
  tx: Transaction,
  owner: { id: number; authEpoch: number },
  email: string,
  emailKey: string,
  passwordHash: string,
  apiVerifier: string,
  source: "account-change" | "recovery",
): Promise<void> {
  const now = new Date();
  const authEpoch = owner.authEpoch + 1;
  if (!Number.isSafeInteger(authEpoch)) throw new AuthError("The account requires operator maintenance.", 503, "UNAVAILABLE");
  await tx.update(owners).set({
    email, emailKey, passwordHash, authEpoch, recoveryRequired: false,
    credentialVersion: 1, passwordChangedAt: now, updatedAt: now,
  }).where(eq(owners.id, owner.id));
  await tx.update(feverCredentials).set({ revokedAt: now })
    .where(and(eq(feverCredentials.ownerId, owner.id), isNull(feverCredentials.revokedAt)));
  await tx.insert(feverCredentials).values({ ownerId: owner.id, verifier: apiVerifier, authEpoch, source })
    .onConflictDoUpdate({ target: feverCredentials.verifier, set: { authEpoch, source, createdAt: now, revokedAt: null } });
  await tx.update(authRecoveryTokens).set({ usedAt: now })
    .where(and(eq(authRecoveryTokens.ownerId, owner.id), isNull(authRecoveryTokens.usedAt)));
  await tx.insert(stateOperations).values({
    ownerId: owner.id, origin: source === "recovery" ? "recovery" : "browser", action: `auth.${source}`,
    affectedIds: [owner.id], before: { authEpoch: owner.authEpoch },
    after: { authEpoch, credentialsChanged: true, apiCredentialRotated: true, requiresCredentialReconciliation: true },
  });
}

export async function verifyOwnerPassword(owner: OwnerContext, password: unknown): Promise<boolean> {
  await assertOwner(owner);
  await consumeRateLimit("account");
  if (!passwordHasSupportedSize(password)) return false;
  const [row] = await getDb().select({ passwordHash: owners.passwordHash }).from(owners)
    .where(and(eq(owners.id, owner.id), eq(owners.email, owner.email))).limit(1);
  return !!row && await verifyPassword(password, row.passwordHash);
}

export async function changeCredentials(owner: OwnerContext, payload: Record<string, unknown>): Promise<{
  ok: true; reauthenticate: true; apiCredentialRotated: true;
}> {
  await assertOwner(owner);
  validateKeys(payload, ["currentPassword", "email", "password"]);
  await consumeRateLimit("account");
  if (!passwordHasSupportedSize(payload.currentPassword)) invalidInput("Enter your current password.", "currentPassword");
  const [current] = await getDb().select().from(owners)
    .where(and(eq(owners.id, owner.id), eq(owners.email, owner.email))).limit(1);
  if (!current || !await verifyPassword(payload.currentPassword, current.passwordHash)) {
    throw new AuthError("The current credentials could not be verified.", 403, "INVALID_CREDENTIALS", undefined, { currentPassword: "Enter your current password." });
  }
  let email = current.email;
  let emailKey = current.emailKey;
  if (payload.email !== undefined) {
    const validatedEmail = validateNewEmail(payload.email);
    emailKey = validatedEmail.emailKey;
    email = validatedEmail.email;
  }
  let password = payload.currentPassword;
  if (payload.password !== undefined && payload.password !== "") {
    try { validateNewPassword(payload.password); } catch (error) { invalidInput((error as Error).message, "password"); }
    password = payload.password;
  }
  if (email === current.email && password === payload.currentPassword) invalidInput("Enter a different email or a new password.");
  const passwordHash = password === payload.currentPassword ? current.passwordHash : await hashPassword(password);
  const apiVerifier = feverDigestVerifier(email, password);
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('fever:installation', 0))`);
    const [locked] = await tx.select().from(owners).where(eq(owners.id, current.id)).for("update");
    const [state] = await tx.select({ status: installation.status }).from(installation).where(eq(installation.id, 1));
    if (!locked || locked.authEpoch !== current.authEpoch || state?.status !== "ready") {
      throw new AuthError("The account changed. Sign in and try again.", 409, "ACCOUNT_CHANGED");
    }
    await rotateCredentials(tx, locked, email, emailKey, passwordHash, apiVerifier, "account-change");
  });
  return { ok: true, reauthenticate: true, apiCredentialRotated: true };
}

/** Revokes every browser session; deliberate API credential rotation is separate. */
export async function revokeSessions(owner: OwnerContext): Promise<void> {
  await assertOwner(owner);
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('fever:installation', 0))`);
    const [state] = await tx.select({ status: installation.status }).from(installation).where(eq(installation.id, 1));
    if (state?.status !== "ready") throw new AuthError("This installation is unavailable.", 503, "UNAVAILABLE");
    const updated = await tx.update(owners).set({ authEpoch: sql`${owners.authEpoch} + 1`, updatedAt: new Date() })
      .where(and(eq(owners.id, owner.id), eq(owners.email, owner.email))).returning({ id: owners.id, authEpoch: owners.authEpoch });
    if (!updated.length) throw new AuthError("Sign in to continue.");
    await tx.update(authRecoveryTokens).set({ usedAt: new Date() })
      .where(and(eq(authRecoveryTokens.ownerId, owner.id), isNull(authRecoveryTokens.usedAt)));
    await tx.insert(stateOperations).values({
      ownerId: owner.id, origin: "browser", action: "auth.logout-all", affectedIds: [owner.id],
      before: { authEpoch: updated[0].authEpoch - 1 }, after: { authEpoch: updated[0].authEpoch },
    });
  });
}

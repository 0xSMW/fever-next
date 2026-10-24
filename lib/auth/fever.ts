import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { feverCredentials, installation, owners } from "@/lib/db/schema";
import type { OwnerContext } from "./owner";
import { consumeRateLimit } from "./rate-limit";
import { assertRequestPath, constantTimeEqual } from "./security";

/** The input is the protocol's bearer MD5, never the owner's password. */
export function verifierForFeverDigest(digest: string): string {
  if (!/^[a-fA-F0-9]{32}$/.test(digest)) throw new Error("Invalid Fever credential format.");
  return createHash("sha256").update(digest.toLowerCase(), "ascii").digest("hex");
}

/** Offline import and credential rotation preserve the exact email/password bytes. */
export function feverDigestVerifier(email: string | Buffer, password: string | Buffer): string {
  const digest = createHash("md5").update(email).update(":").update(password).digest("hex");
  return verifierForFeverDigest(digest);
}

export async function authenticateFeverDigest(digest: string, request?: Request): Promise<OwnerContext | null> {
  if (request) assertRequestPath(request);
  await consumeRateLimit("fever");
  if (typeof digest !== "string" || !/^[a-fA-F0-9]{32}$/.test(digest)) return null;
  const presented = verifierForFeverDigest(digest);
  // One active owner credential: fetch by owner, then compare in constant time.
  // Browser logout-all changes the session epoch without revoking the API key.
  const [row] = await getDb().select({
    id: owners.id, email: owners.email, verifier: feverCredentials.verifier,
  }).from(feverCredentials).innerJoin(owners, eq(feverCredentials.ownerId, owners.id))
    .innerJoin(installation, eq(installation.id, 1))
    .where(and(isNull(feverCredentials.revokedAt), eq(owners.recoveryRequired, false), eq(installation.status, "ready"))).limit(1);
  const expected = row?.verifier ?? "0".repeat(64);
  return constantTimeEqual(expected, presented) && row ? { id: row.id, email: row.email } : null;
}

import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getConfig, SCHEMA_VERSION } from "@/lib/config";
import { createDefaultPreferences } from "@/lib/reader-policy";
import { getDb } from "@/lib/db/client";
import { favicons, feverCredentials, installation, owners, readerPreferences, readerViewState, sharingServices, stateOperations } from "@/lib/db/schema";
import { defaultFaviconRecord } from "./default-favicon";
import { AuthError, invalidInput } from "./errors";
import { feverDigestVerifier } from "./fever";
import { hashPassword, validateNewPassword } from "./password";
import { consumeRateLimit } from "./rate-limit";
import { getAuthRuntime } from "./runtime";
import { constantTimeEqual, validateNewEmail, validateKeys } from "./security";

function setupClosed(): never {
  throw new AuthError("This installation has already been initialized. Sign in or use operator recovery.", 409, "SETUP_CLOSED");
}

export async function isInstallationConfigured(): Promise<boolean> {
  const [state] = await getDb().select({ closed: installation.setupClosed, status: installation.status })
    .from(installation).where(eq(installation.id, 1));
  // A preserved owner or closed sentinel prevents an absent/inconsistent config from reopening setup.
  const [owner] = await getDb().select({ id: owners.id }).from(owners).limit(1);
  return !!owner || !!state?.closed || (!!state && state.status !== "uninitialized");
}

export async function initializeInstallation(payload: Record<string, unknown>): Promise<{ ok: true; configured: true }> {
  validateKeys(payload, ["token", "email", "password", "useCelsius", "baseUrl"]);
  await consumeRateLimit("setup");
  const runtime = getAuthRuntime();
  const config = getConfig();
  if (!config.setupToken || Buffer.byteLength(config.setupToken) < 32 || !config.encryptionKeys[config.encryptionKeyId]) {
    throw new AuthError("The operator must finish the installation configuration before setup.", 503, "SETUP_UNAVAILABLE");
  }
  const suppliedToken = typeof payload.token === "string" && payload.token.length <= 512 ? payload.token : "";
  const tokenMatches = constantTimeEqual(
    createHash("sha256").update(suppliedToken).digest("hex"),
    createHash("sha256").update(config.setupToken).digest("hex"),
  );
  if (!tokenMatches) throw new AuthError("The installation token is invalid.", 403, "INVALID_SETUP_TOKEN", undefined, { token: "Enter the operator's installation token." });
  if (await isInstallationConfigured()) setupClosed();
  const { email, emailKey } = validateNewEmail(payload.email);
  try { validateNewPassword(payload.password); } catch (error) { invalidInput((error as Error).message, "password"); }
  if (typeof payload.useCelsius !== "boolean") invalidInput("Choose Celsius or Fahrenheit.", "useCelsius");
  if (payload.baseUrl !== undefined && (typeof payload.baseUrl !== "string" || payload.baseUrl.replace(/\/$/, "") !== runtime.baseUrl)) {
    invalidInput("The installation URL must match the operator-configured canonical URL.", "baseUrl");
  }
  const passwordHash = await hashPassword(payload.password);
  const verifier = feverDigestVerifier(email, payload.password);
  const defaults = createDefaultPreferences();
  const { services, ...preferences } = defaults;
  const useCelsius = payload.useCelsius;
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('fever:installation', 0))`);
    // The singleton insert plus row lock serializes concurrent first-run requests.
    await tx.insert(installation).values({ id: 1, schemaVersion: SCHEMA_VERSION }).onConflictDoNothing();
    const [state] = await tx.select().from(installation).where(eq(installation.id, 1)).for("update");
    const [existing] = await tx.select({ id: owners.id }).from(owners).limit(1);
    if (!state || state.setupClosed || state.status !== "uninitialized" || existing) setupClosed();
    if (state.schemaVersion !== SCHEMA_VERSION) throw new AuthError("The operator must update the database schema before setup.", 503, "SCHEMA_MISMATCH");
    const [existingFavicon] = await tx.select({ id: favicons.id }).from(favicons).limit(1);
    if (existingFavicon) throw new AuthError("The database contains unexpected favicon data. Ask the operator to review it before setup.", 409, "SETUP_DATA_CONFLICT");
    await tx.insert(owners).values({ id: 1, email, emailKey, passwordHash, authEpoch: 1, credentialVersion: 1 });
    await tx.insert(favicons).values(defaultFaviconRecord(1));
    // Explicit ID 1 does not advance PostgreSQL's identity. Consuming one value
    // reserves its initial 1 and never moves an already advanced sequence back.
    const sequence = await tx.execute<{ reserved: string | null }>(sql`select nextval(pg_get_serial_sequence('favicons', 'id'))::text as reserved`);
    const reserved = sequence.rows[0]?.reserved;
    if (!reserved || !/^[1-9][0-9]*$/.test(reserved) || BigInt(reserved) >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AuthError("The default favicon identity could not be reserved.", 503, "SCHEMA_MISMATCH");
    }
    await tx.insert(feverCredentials).values({ ownerId: 1, verifier, authEpoch: 1, source: "setup" });
    await tx.insert(readerPreferences).values({ ownerId: 1, ...preferences, useCelsius, share: false });
    await tx.insert(readerViewState).values({ ownerId: 1, deviceId: "default" });
    if (services.length) await tx.insert(sharingServices).values(services.map((service, position) => ({
      ownerId: 1, position, name: service.name, url: service.url, originalUrl: service.url,
      key: service.key, enabled: service.enabled ?? true, transport: "navigate",
    })));
    await tx.update(installation).set({
      status: "ready", setupClosed: true, baseUrl: runtime.baseUrl,
      installedAt: Math.floor(Date.now() / 1000), updatedAt: new Date(),
    }).where(eq(installation.id, 1));
    await tx.insert(stateOperations).values({
      ownerId: 1, origin: "setup", action: "auth.setup", affectedIds: [1],
      after: { configured: true, setupClosed: true, schemaVersion: SCHEMA_VERSION },
    });
  });
  return { ok: true, configured: true };
}

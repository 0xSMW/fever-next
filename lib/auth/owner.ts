import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { getDb } from "@/lib/db/client";
import { installation, owners } from "@/lib/db/schema";
import { AuthError } from "./errors";
import { getAuthRuntime } from "./runtime";
import { assertCsrf, assertRequestPath } from "./security";

export interface OwnerContext { id: number; email: string; }
export interface AuthenticatedOwner extends OwnerContext { authEpoch: number; }
const sessionEpochs = new WeakMap<OwnerContext, number>();

function browserOwnerContext(owner: AuthenticatedOwner): OwnerContext {
  const context = { id: owner.id, email: owner.email };
  sessionEpochs.set(context, owner.authEpoch);
  return context;
}

/** Internal service-boundary check; API/worker contexts have separate authorization. */
export function getCheckedSessionEpoch(owner: OwnerContext): number | undefined {
  return sessionEpochs.get(owner);
}

export async function getAuthenticatedOwner(request?: Request): Promise<AuthenticatedOwner | null> {
  if (request) assertRequestPath(request);
  const runtime = getAuthRuntime();
  const requestHeaders = request?.headers ?? await headers();
  const token = await getToken({
    req: new NextRequest(request?.url ?? `${runtime.baseUrl}/`, { headers: requestHeaders }),
    secret: runtime.secret,
    cookieName: runtime.sessionCookieName,
    secureCookie: runtime.secure,
  });
  const id = Number(token?.sub);
  const epoch = token?.authEpoch;
  const deadline = token?.authenticatedUntil;
  if (token?.installationUrl !== runtime.baseUrl || !Number.isSafeInteger(id) || id < 1 || typeof epoch !== "number" || !Number.isSafeInteger(epoch) ||
      typeof deadline !== "number" || deadline <= Math.floor(Date.now() / 1000) || token?.revoked) return null;
  const [owner] = await getDb().select({ id: owners.id, email: owners.email, authEpoch: owners.authEpoch })
    .from(owners).innerJoin(installation, eq(installation.id, 1))
    .where(and(eq(owners.id, id), eq(owners.authEpoch, epoch), eq(owners.recoveryRequired, false), eq(installation.status, "ready"))).limit(1);
  return owner ?? null;
}

export async function getOwner(request?: Request): Promise<OwnerContext | null> {
  const owner = await getAuthenticatedOwner(request);
  return owner ? browserOwnerContext(owner) : null;
}

export async function requireOwner(request?: Request): Promise<OwnerContext> {
  const owner = await getOwner(request);
  if (!owner) throw new AuthError("Sign in to continue.");
  return owner;
}

export async function requireMutation(request: Request): Promise<OwnerContext> {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    throw new AuthError("Use a state-changing request method.", 405, "METHOD_NOT_ALLOWED");
  }
  const owner = await getAuthenticatedOwner(request);
  if (!owner) throw new AuthError("Sign in to continue.");
  assertCsrf(request, owner);
  return browserOwnerContext(owner);
}

/** Services recheck that their context still resolves to this installation's owner. */
export async function assertOwner(owner: OwnerContext): Promise<void> {
  if (!Number.isSafeInteger(owner.id) || owner.id < 1) throw new AuthError("Sign in to continue.");
  // Browser contexts retain their checked epoch without expanding the public DTO.
  // Explicit worker/API contexts have their own installation/bearer authorization.
  const epoch = getCheckedSessionEpoch(owner);
  const [row] = await getDb().select({ id: owners.id }).from(owners)
    .innerJoin(installation, eq(installation.id, 1))
    .where(and(eq(owners.id, owner.id), eq(owners.email, owner.email), epoch === undefined ? undefined : eq(owners.authEpoch, epoch),
      eq(owners.recoveryRequired, false), eq(installation.status, "ready"))).limit(1);
  if (!row) throw new AuthError("Sign in to continue.");
}

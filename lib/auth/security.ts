import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { AuthError, invalidInput } from "./errors";
import { getAuthRuntime } from "./runtime";

const CSRF_LIFETIME_SECONDS = 3600;
const TOKEN_PATTERN = /^[a-f0-9]{64}\.[0-9]{10,12}\.[a-f0-9]{64}\.[a-f0-9]{64}$/;

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function mac(value: string): string {
  const runtime = getAuthRuntime();
  return createHmac("sha256", runtime.secret).update(`fever-browser-csrf-v1\0${runtime.baseUrl}\0${value}`).digest("hex");
}

export function csrfBinding(owner: { id: number; authEpoch: number } | null): string {
  return mac(owner ? `owner:${owner.id}:${owner.authEpoch}` : "anonymous");
}

export function readCookie(request: Request, name: string): string | null {
  const matches = (request.headers.get("cookie") ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  // Cookie tossing must not choose an arbitrary one of two same-name cookies.
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  try { return decodeURIComponent(value); } catch { return null; }
}

function isValidCsrf(token: string, binding: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  const [nonce, timestamp, subject, signature] = token.split(".");
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  return age >= 0 && age < CSRF_LIFETIME_SECONDS && constantTimeEqual(subject, binding) &&
    constantTimeEqual(signature, mac(`${nonce}.${timestamp}.${subject}`));
}

export function issueCsrfToken(request: Request, owner: { id: number; authEpoch: number } | null): { token: string; cookie: string } {
  const runtime = getAuthRuntime();
  const binding = csrfBinding(owner);
  const existing = readCookie(request, runtime.csrfCookieName);
  const payload = `${randomBytes(32).toString("hex")}.${Math.floor(Date.now() / 1000)}.${binding}`;
  const token = existing && isValidCsrf(existing, binding) ? existing : `${payload}.${mac(payload)}`;
  const cookie = `${runtime.csrfCookieName}=${token}; Path=${runtime.cookiePath}; Max-Age=${CSRF_LIFETIME_SECONDS}; HttpOnly; SameSite=Strict${runtime.secure ? "; Secure" : ""}`;
  return { token, cookie };
}

/** Validate the public origin and path, never trusting a caller-selected forwarded host. */
export function assertRequestPath(request: Request): void {
  const runtime = getAuthRuntime();
  const url = new URL(request.url);
  const host = request.headers.get("host");
  const inInstallation = !runtime.basePath || url.pathname === runtime.basePath || url.pathname.startsWith(`${runtime.basePath}/`);
  // Next 16 AppRoute removes the configured public basePath before constructing
  // NextRequest. Its router has already enforced that prefix. Accept only our
  // internal API paths in that case; ordinary Request callers need the public path.
  const normalizedApi = request instanceof NextRequest && url.pathname.startsWith("/api/");
  if (url.origin !== runtime.origin || (host !== null && host.toLowerCase() !== new URL(runtime.origin).host.toLowerCase()) ||
      (!inInstallation && !normalizedApi)) {
    throw new AuthError("The request address is invalid.", 403, "INVALID_ORIGIN");
  }
  if (/\/{2}|%(?:2f|5c)/i.test(url.pathname)) throw new AuthError("The request path is invalid.", 403, "INVALID_ORIGIN");
}

export function assertSameOrigin(request: Request): void {
  assertRequestPath(request);
  const runtime = getAuthRuntime();
  const origin = request.headers.get("origin");
  if (origin !== runtime.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AuthError("Reload Fever and try again.", 403, "INVALID_ORIGIN");
  }
  // Origin does not include a base path; Referer, when present, must stay in this installation.
  const referer = request.headers.get("referer");
  if (referer) {
    let url: URL;
    try { url = new URL(referer); } catch { throw new AuthError("Reload Fever and try again.", 403, "INVALID_ORIGIN"); }
    if (url.origin !== runtime.origin || (runtime.basePath && url.pathname !== runtime.basePath && !url.pathname.startsWith(`${runtime.basePath}/`))) {
      throw new AuthError("Reload Fever and try again.", 403, "INVALID_ORIGIN");
    }
  }
}

export function assertCsrf(request: Request, owner: { id: number; authEpoch: number } | null): void {
  assertSameOrigin(request);
  const token = request.headers.get("x-fever-csrf");
  const cookie = readCookie(request, getAuthRuntime().csrfCookieName);
  if (!token || !cookie || !constantTimeEqual(token, cookie) || !isValidCsrf(token, csrfBinding(owner))) {
    throw new AuthError("Your form expired. Reload Fever and try again.", 403, "INVALID_CSRF");
  }
}

export async function readJsonBody(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new AuthError("Use an application/json request.", 415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const text = await readBoundedBody(request, maxBytes);
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalidInput("The request body is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidInput("The request body must be an object.");
  return value as Record<string, unknown>;
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new AuthError("The request is too large.", 413, "PAYLOAD_TOO_LARGE");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new AuthError("The request is too large.", 413, "PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { invalidInput("The request must use UTF-8."); }
}

export function validateKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalidInput("The request contains an unsupported field.");
}

export function normalizeLoginEmail(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 320 || /[\u0000-\u001f\u007f]/.test(value)) invalidInput("Enter a valid email address.", "email");
  const email = value.trim();
  if (!email) invalidInput("Enter a valid email address.", "email");
  return email.toLowerCase();
}

/** New-account validation must not make an imported historical login unreachable. */
export function validateNewEmail(value: unknown): { email: string; emailKey: string } {
  const emailKey = normalizeLoginEmail(value);
  const email = (value as string).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalidInput("Enter a valid email address.", "email");
  return { email, emailKey };
}

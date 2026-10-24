import "server-only";
import { randomUUID } from "node:crypto";
import type { ApiError } from "@/lib/contracts";
import { FetchError } from "@/lib/ingest/http";
import { logEvent } from "@/lib/observability/log";

export class HttpError extends Error {
  constructor(message: string, public status = 400, public code = "INVALID_REQUEST", public fields?: Record<string, string>) { super(message); }
}

export const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
export function json(data: unknown, status = 200, extra: HeadersInit = {}) {
  const headers = new Headers(privateHeaders);
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return Response.json(data, { status, headers });
}

/** Do not echo unexpected database, parser, transport, or credential errors. */
export async function endpoint(work: () => Promise<Response>): Promise<Response> {
  const requestId = randomUUID();
  try {
    const response = await work();
    response.headers.set("X-Request-ID", requestId);
    return response;
  } catch (error) {
    if (error instanceof FetchError) {
      // An upstream 401 describes a protected feed, not an expired Fever login.
      const invalid = new Set(["invalid_url", "blocked_address", "blocked_port", "credentials", "requires_auth", "content_type", "not_feed", "invalid_image", "too_large"]);
      const status = error.code === "timeout" ? 504 : invalid.has(error.code) ? 422 : 502;
      error = Object.assign(new HttpError(error.message, status, error.code), { retryAfter: error.retryAfter });
    }
    const known = error instanceof Error && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status <= 504 && "code" in error && typeof error.code === "string";
    const e = (error instanceof Error ? error : {}) as Error & { status?: number; code?: string; fields?: Record<string, string>; retryAfter?: number };
    const body: ApiError = known ? { error: e.message, code: e.code, fields: e.fields } : { error: "The request could not be completed.", code: "INTERNAL_ERROR" };
    logEvent("http.request_failed", { requestId, status: known ? e.status : 500, code: known ? e.code : "INTERNAL_ERROR" });
    return json(body, known ? e.status : 500, { "X-Request-ID": requestId, ...(known && e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {}) });
  }
}

export async function readText(request: Request, limit = 1_048_576): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError("The request body is too large.", 413, "BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError("The request body is too large.", 413, "BODY_TOO_LARGE"); }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("The request body must be valid UTF-8.");
  } finally { reader.releaseLock(); }
}

export async function readJson(request: Request, limit?: number): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new HttpError("Send an application/json request.", 415, "CONTENT_TYPE");
  let value: unknown;
  try { value = JSON.parse(await readText(request, limit)); } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("The JSON request could not be read.");
  }
  return record(value);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError("Expected an object.");
  return value as Record<string, unknown>;
}
export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if ((typeof value !== "string" && typeof value !== "number") || !/^-?\d+$/.test(String(value))) throw new HttpError(`${name} must be an integer.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(`${name} is out of range.`);
  return n;
}
export function csvIds(value: string | null, name: string, allowZero = false): number[] {
  if (value === null || value === "") return [];
  const parts = value.split(",");
  if (parts.length > 10_000) throw new HttpError(`${name} contains too many IDs.`);
  return [...new Set(parts.map(part => integer(part.trim(), name, allowZero ? 0 : 1)))];
}
export function bool(value: string | null, name: string): boolean | undefined {
  if (value === null) return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new HttpError(`${name} must be true or false.`);
}
export function xmlText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

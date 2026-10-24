/**
 * Browser API helper shared by every Fever frontend surface. It has no
 * top-level browser access, so server components may import appHref.
 *
 * - All URLs are prefixed with NEXT_PUBLIC_BASE_PATH (inlined at build time).
 * - Mutations carry X-Fever-CSRF from GET /api/session; an expired token is
 *   refreshed once and the request retried.
 * - Failures throw ApiRequestError carrying the server's ApiError fields.
 * - A 401 also dispatches the "fever:session-expired" window event so the
 *   reader can show its explicit expired-session state.
 */
import type { ApiError, CommandAction, CommandPayload, CommandResult, SessionDTO } from "@/lib/contracts";

export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
export const SESSION_EXPIRED_EVENT = "fever:session-expired";

/** Prefix an application path ("/api/reader?x=1") with the deployment base path. */
export function appHref(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new TypeError("appHref only accepts application-relative paths.");
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${normalized}`;
}

/** A failed request; carries the ApiError code and field messages. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly fields?: Record<string, string>;
  readonly retryAfter?: number;
  constructor(message: string, status: number, code?: string, fields?: Record<string, string>, retryAfter?: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
  /** The error is an authentication failure, not a validation or server error. */
  get isUnauthenticated(): boolean { return this.status === 401 || this.code === "UNAUTHENTICATED"; }
  get isAborted(): boolean { return this.code === "ABORTED"; }
}

export function isApiError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

/** A readable message for any thrown value. */
export function errorMessage(error: unknown, fallback = "The request could not be completed."): string {
  if (error instanceof ApiRequestError) return error.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export interface RequestOptions { signal?: AbortSignal; }

let csrfToken: string | null = null;
let sessionRequest: Promise<SessionDTO> | null = null;

/** GET /api/session; caches the CSRF token. Pass force to bypass the in-flight/cached value. */
export function getSession(force = false): Promise<SessionDTO> {
  if (!force && sessionRequest) return sessionRequest;
  const pending = (async () => {
    const response = await rawFetch("GET", "/api/session");
    const session = await parse<SessionDTO>(response);
    csrfToken = session.csrfToken || null;
    return session;
  })();
  sessionRequest = pending;
  pending.catch(() => { if (sessionRequest === pending) sessionRequest = null; });
  return pending;
}

/** Forget the cached session (after sign-in/out). */
export function resetSession(): void {
  csrfToken = null;
  sessionRequest = null;
}

async function ensureCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const session = await getSession(true);
  if (!session.csrfToken) throw new ApiRequestError("Reload Fever and try again.", 403, "INVALID_CSRF");
  return session.csrfToken;
}

async function rawFetch(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  try {
    const response = await fetch(appHref(path), {
      method,
      credentials: "same-origin",
      cache: "no-store",
      // An API must answer with JSON; a redirect means a login page or proxy intercepted it.
      redirect: "manual",
      signal,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.type === "opaqueredirect") {
      return new Response(JSON.stringify({ error: "Your session has expired. Log in again.", code: "UNAUTHENTICATED" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ApiRequestError("The request was cancelled.", 0, "ABORTED");
    throw new ApiRequestError("Fever could not be reached. Check your connection and try again.", 0, "NETWORK_ERROR");
  }
}

async function parse<T>(response: Response): Promise<T> {
  const type = response.headers.get("content-type") ?? "";
  let data: unknown = null;
  if (type.includes("application/json")) {
    try { data = await response.json(); } catch { data = null; }
  }
  if (!response.ok) {
    const body = (data && typeof data === "object" ? data : {}) as Partial<ApiError>;
    const retry = Number(response.headers.get("retry-after"));
    const error = new ApiRequestError(
      typeof body.error === "string" && body.error ? body.error : defaultMessage(response.status),
      response.status,
      typeof body.code === "string" ? body.code : response.status === 401 ? "UNAUTHENTICATED" : undefined,
      body.fields && typeof body.fields === "object" ? body.fields : undefined,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
    if (error.isUnauthenticated && typeof window !== "undefined") {
      csrfToken = null;
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    throw error;
  }
  if (!type.includes("application/json")) {
    throw new ApiRequestError("Fever returned an unexpected response.", response.status, "BAD_RESPONSE");
  }
  return data as T;
}

function defaultMessage(status: number): string {
  if (status === 401) return "Your session has expired. Log in again.";
  if (status === 403) return "This action is not allowed. Reload Fever and try again.";
  if (status === 404) return "That item no longer exists.";
  if (status === 413) return "The request is too large.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500) return "Fever could not complete the request. Try again shortly.";
  return "The request could not be completed.";
}

export async function apiGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return parse<T>(await rawFetch("GET", path, undefined, {}, options.signal));
}

export async function apiPost<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  const send = async (token: string) => rawFetch("POST", path, body ?? {}, { "X-Fever-CSRF": token }, options.signal);
  let response = await send(await ensureCsrf());
  if (response.status === 403) {
    // Only a stale CSRF token is retried; other 403s are reported as-is.
    const copy = response.clone();
    let code: unknown;
    try { code = ((await copy.json()) as Partial<ApiError>).code; } catch { code = undefined; }
    if (code === "INVALID_CSRF") {
      csrfToken = null;
      response = await send(await ensureCsrf());
    }
  }
  return parse<T>(response);
}

export function command<A extends CommandAction>(action: A, payload: CommandPayload<A>): Promise<CommandResult<A>> {
  return apiPost<CommandResult<A>>("/api/commands", { action, payload });
}

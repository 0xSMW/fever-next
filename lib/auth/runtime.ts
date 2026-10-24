import { createHash } from "node:crypto";

export interface AuthRuntime {
  baseUrl: string;
  origin: string;
  basePath: string;
  cookiePath: string;
  secure: boolean;
  secret: string;
  sessionCookieName: string;
  csrfCookieName: string;
  authCookiePrefix: string;
}

/** Lazy configuration: importing a server module never opens a connection or reads credentials. */
export function getAuthRuntime(): AuthRuntime {
  const raw = process.env.FEVER_BASE_URL;
  if (!raw) throw new Error("FEVER_BASE_URL must be configured with the canonical installation URL.");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("FEVER_BASE_URL must be a clean HTTP(S) installation URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && (process.env.NODE_ENV === "production" || !local)) {
    throw new Error("Fever requires HTTPS except for local development.");
  }
  const basePath = url.pathname.replace(/\/$/, "");
  if (basePath && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) {
    throw new Error("FEVER_BASE_URL has an unsupported base path.");
  }
  const publicBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (publicBasePath !== basePath) throw new Error("NEXT_PUBLIC_BASE_PATH must match FEVER_BASE_URL.");
  const baseUrl = `${url.origin}${basePath}`;
  const authUrl = process.env.NEXTAUTH_URL;
  if (!authUrl || authUrl.replace(/\/$/, "") !== `${baseUrl}/api/auth`) {
    throw new Error("NEXTAUTH_URL must equal FEVER_BASE_URL followed by /api/auth.");
  }
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("NEXTAUTH_SECRET must contain at least 32 bytes of independent random material.");
  const secure = url.protocol === "https:";
  const suffix = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
  const authCookiePrefix = `${secure ? "__Secure-" : ""}fever-${suffix}`;
  return {
    // RFC cookie path matching includes /base and /base/*, but excludes /base-other.
    baseUrl, origin: url.origin, basePath, cookiePath: basePath || "/", secure, secret,
    authCookiePrefix,
    sessionCookieName: `${authCookiePrefix}.session-token`,
    csrfCookieName: `${authCookiePrefix}.csrf`,
  };
}

export function safeRedirect(value: string): string {
  const config = getAuthRuntime();
  try {
    // Backslashes and encoded path separators can acquire different meanings at proxies.
    if (/[\\\u0000-\u001f\u007f]/.test(value) || /%(?:2f|5c)/i.test(value)) return `${config.baseUrl}/`;
    const url = new URL(value, `${config.baseUrl}/`);
    if (url.origin !== config.origin || (config.basePath && url.pathname !== config.basePath && !url.pathname.startsWith(`${config.basePath}/`))) {
      return `${config.baseUrl}/`;
    }
    return url.href;
  } catch {
    return `${config.baseUrl}/`;
  }
}

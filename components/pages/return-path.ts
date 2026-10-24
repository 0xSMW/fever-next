/**
 * Return-path validation shared by server pages and client components.
 *
 * A return path is always app-relative (no base path, no origin): "/", or
 * "/feedlet?url=...". Anything that could leave the installation or be read
 * differently by a proxy falls back to "/". Login, setup, and recovery are
 * never valid targets, so a crafted link cannot loop the login form.
 */
const MAX_RETURN_LENGTH = 6000;
const BLOCKED_PREFIXES = ["/login", "/setup", "/recovery", "/api/"];

export function safeReturnPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  const path = value.trim();
  if (!path || path.length > MAX_RETURN_LENGTH) return fallback;
  // Single leading slash only: "//host" and "/\host" are protocol-relative to browsers.
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return fallback;
  // Encoded separators and dot segments can be decoded differently by proxies.
  if (/%(?:2f|5c|00)/i.test(path.split(/[?#]/, 1)[0])) return fallback;
  if (/(^|\/)\.\.?(\/|$|[?#])/.test(path.split(/[?#]/, 1)[0])) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(path, "http://fever.invalid");
  } catch {
    return fallback;
  }
  if (parsed.origin !== "http://fever.invalid") return fallback;
  const pathname = parsed.pathname;
  if (BLOCKED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) {
    return fallback;
  }
  return `${pathname}${parsed.search}${parsed.hash}`;
}

/** Login URL that returns to the given app-relative path after sign-in. */
export function loginPath(returnTo: string): string {
  const safe = safeReturnPath(returnTo);
  return safe === "/" ? "/login" : `/login?return=${encodeURIComponent(safe)}`;
}

/** First value of a Next.js search parameter. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * An external page the Feedlet was opened from. Only plain HTTP(S) URLs
 * without credentials are offered as a "return to page" link, so a crafted
 * Feedlet URL cannot turn Cancel into a javascript: or data: link.
 */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(value.trim().replace(/^feed:\/\//i, "http://"));
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
  return url.href;
}

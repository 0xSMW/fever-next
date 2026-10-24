import { createHash } from "node:crypto";

/** Versioned comparison rules from util.php, not a navigation-URL sanitizer. */
export const LEGACY_URL_VERSION = 1;

/** PHP strtolower on this source's byte strings only folds ASCII. */
export function legacyLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function normalizeUrl(value: string): string {
  return value
    .replace(/^(?:https?|feed):\/\/(?:www\.)?([^.]+\.)/i, "$1")
    .replace(/^[^/]+\//, (domain) => legacyLower(domain))
    .replace(/\/index\.[a-z0-9]+/gi, "")
    .replace(/\/\?/g, "?")
    .replace(/\/$/, "");
}

function wrapperArgument(query: string, name: string): string | undefined {
  // parse_str keeps the final duplicate value. Do not use URL.searchParams:
  // the source passes the entire captured tail, including any fragment.
  let result: string | undefined;
  let arrayValue = false;
  for (const [key, value] of new URLSearchParams(query)) {
    if (key === name) { result = value; arrayValue = false; }
    if (key.startsWith(`${name}[`)) {
      arrayValue = true;
    }
  }
  // parse_str permits a later scalar to replace an earlier array value.
  // An eventual array is not a usable URL; never silently stringify it.
  if (arrayValue) throw new TypeError(`The ${name} redirect argument must be a string`);
  return result;
}

export function trueUrl(value: string): string {
  let result = value;
  const bird = /\/feeder\/\?(.+)/i.exec(result);
  if (bird) result = wrapperArgument(bird[1], "seed") ?? result;
  const redirect = /\/rd\?(.+)/i.exec(result);
  if (redirect) {
    result = wrapperArgument(redirect[1], "rd")
      ?? wrapperArgument(redirect[1], "url")
      ?? result;
  }
  return result;
}

/** The unsigned PHP crc32 result; UTF-8 bytes are significant. */
export function checksum(value: string): number {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(value, "utf8")) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** SHA-256 is an indexed lookup key; compare the full value on every match. */
export function canonicalUrlKey(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl, "utf8").digest("hex");
}

/**
 * util.php resolve(), including its legacy filename/port/../ quirks. This is
 * used only to preserve occurrence identity. It does not approve a URL for
 * fetching or browser navigation. Protocol-relative links used request TLS,
 * not the feed's scheme; callers can supply that frozen legacy context.
 */
export function resolveLegacyUrl(base: string, target: string, requestIsHttps = false): string {
  if (/^(https?|javascript):/i.test(target)) return target;
  if (target.startsWith("//")) return `${requestIsHttps ? "https:" : "http:"}${target}`;
  if (target.startsWith("/")) return base.replace(/^(https?:\/\/[^/]+).*$/i, "$1") + target;

  const parsed = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:[^/@]*@)?(\[[^\]]+\]|[^/:?#]+)?(?::[0-9]+)?([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(base);
  if (!parsed) throw new TypeError("Cannot resolve a link against an invalid legacy base URL");
  const scheme = parsed[1] || "http";
  const host = parsed[2] || "localhost";
  const path = parsed[3] || "/";
  const prefix = `${scheme}://${host}${path.replace(/([^./]+\.[^./]+)$/, "")}`;
  const parents = (target.match(/\.\.\//g) ?? []).length;
  if (!parents) return prefix + target;
  return (prefix + target).replace(new RegExp(`([^/]+/){${parents}}(\\.\\./){${parents}}`, "g"), "");
}

export interface CanonicalOccurrence {
  canonicalUrl: string;
  canonicalKey?: string;
  legacyUrlChecksum: number;
}

export class LegacyUrlCollisionError extends Error {
  readonly code = "LEGACY_URL_COLLISION";
  constructor(readonly legacyChecksum: number) {
    super(`Legacy URL checksum ${legacyChecksum} identifies multiple URLs; an explicit migration resolution is required`);
    this.name = "LegacyUrlCollisionError";
  }
}

/** Never allow an imported CRC collision to merge articles silently. */
export function assertNoLegacyUrlCollisions(occurrences: readonly CanonicalOccurrence[]): void {
  const checksums = new Map<number, string>();
  const keys = new Map<string, string>();
  for (const occurrence of occurrences) {
    const previous = checksums.get(occurrence.legacyUrlChecksum);
    if (previous !== undefined && previous !== occurrence.canonicalUrl) {
      throw new LegacyUrlCollisionError(occurrence.legacyUrlChecksum);
    }
    checksums.set(occurrence.legacyUrlChecksum, occurrence.canonicalUrl);
    if (occurrence.canonicalKey) {
      const full = keys.get(occurrence.canonicalKey);
      if (full !== undefined && full !== occurrence.canonicalUrl) {
        throw new Error("Canonical URL digest collision requires explicit reconciliation");
      }
      keys.set(occurrence.canonicalKey, occurrence.canonicalUrl);
    }
  }
}

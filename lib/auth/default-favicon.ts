import { DEFAULT_FAVICON_ID } from "@/lib/config";
import { sha256 } from "@/lib/crypto";
import { canonicalUrlKey, checksum, normalizeUrl } from "@/lib/legacy-url";

/** Exact fallback bytes from PHP add_default_favicon(); no filesystem or config reads. */
export function defaultFaviconRecord(ownerId = 1, cachedAt = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1 || !Number.isSafeInteger(cachedAt) || cachedAt < 0) {
    throw new TypeError("Invalid default favicon ownership or cache time.");
  }
  const url = normalizeUrl("favicon.png").trim();
  const data = Buffer.from("R0lGODlhAQABAIAAAObm5gAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
  return {
    id: DEFAULT_FAVICON_ID, ownerId, url, urlKey: canonicalUrlKey(url), urlChecksum: checksum(url),
    mimeType: "image/gif", data, contentHash: sha256(data), cachedAt, isDefault: true,
  };
}

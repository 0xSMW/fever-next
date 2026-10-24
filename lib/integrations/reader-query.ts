import type { ReaderQuery, Section } from "@/lib/contracts";
import { bool, HttpError, integer } from "./http";
const sections = new Set<Section>(["hot", "kindling", "saved", "sparks", "search"]);
export function readerQuery(params: URLSearchParams): ReaderQuery & { deviceKey?: string } {
  const query: ReaderQuery & { deviceKey?: string } = {};
  for (const key of ["section", "previous"] as const) {
    const value = params.get(key);
    if (value !== null) { if (!sections.has(value as Section)) throw new HttpError("Unknown reader section."); query[key] = value as Section; }
  }
  for (const key of ["feedId", "groupId", "hotStart", "hotRange", "page"] as const) {
    const value = params.get(key);
    if (value !== null) query[key] = integer(value, key, key === "page" ? 1 : 0, key === "page" ? 1_000_000 : Number.MAX_SAFE_INTEGER);
  }
  for (const key of ["showRead", "showFeeds"] as const) { const value = bool(params.get(key), key); if (value !== undefined) query[key] = value; }
  for (const key of ["search", "cursor", "hasFocus"] as const) {
    const value = params.get(key);
    if (value !== null) { if (value.length > (key === "search" ? 1000 : 2048)) throw new HttpError(`${key} is too long.`); query[key] = value; }
  }
  const deviceKey = params.get("deviceKey");
  if (deviceKey !== null) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(deviceKey)) throw new HttpError("Invalid reader device key.");
    query.deviceKey = deviceKey;
  }
  return query;
}

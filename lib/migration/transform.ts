import type { Preferences, Section, ViewState } from "../contracts";
import { createDefaultPreferences, createDefaultViewState } from "../config";
import { decodePhp, phpObject, strictBase64, utf8, type PhpValue } from "./php";
import type { Cell, SnapshotRow } from "./types";

export class MappingError extends Error {
  constructor(readonly code: string, readonly field: string, message: string) { super(message); }
}
export function bytes(cell: Cell | undefined, field: string): Buffer {
  if (!cell) throw new MappingError("REQUIRED_VALUE", field, "Required source value is NULL or absent");
  return strictBase64(cell.base64);
}
export function text(row: SnapshotRow, field: string, nullable = false): string | null {
  if (row.fields[field] === null && nullable) return null;
  try { return utf8(bytes(row.fields[field], field)); } catch (error) {
    if (error instanceof MappingError) throw error;
    throw new MappingError("INVALID_TEXT", field, "Source bytes cannot be represented as PostgreSQL UTF-8 text");
  }
}
export function uint(row: SnapshotRow, field: string, minimum = 0): number {
  const raw = text(row, field);
  if (raw === null || !/^\d+$/.test(raw)) throw new MappingError("INVALID_INTEGER", field, "Expected an unsigned integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > 4_294_967_295) throw new MappingError("INTEGER_RANGE", field, "Source value is outside the unsigned 32-bit range");
  return value;
}
function flag(row: SnapshotRow, field: string): boolean {
  const value = uint(row, field);
  if (value > 1) throw new MappingError("INVALID_FLAG", field, "Expected the exact flag value 0 or 1");
  return value === 1;
}
function option(row: SnapshotRow, field: string, maximum: number): number {
  const value = text(row, field);
  if (value === null || !/^-?\d+$/.test(value) || Number(value) < -1 || Number(value) > maximum) throw new MappingError("INVALID_OPTION", field, "Invalid display override");
  return Number(value);
}
function options(row: SnapshotRow) { return { itemExcerpts: option(row, "item_excerpts", 1), itemAllows: option(row, "item_allows", 2), unreadCounts: option(row, "unread_counts", 1), sortOrder: option(row, "sort_order", 1) }; }
function stringValue(value: PhpValue | undefined, field: string): string {
  if (!Buffer.isBuffer(value)) throw new MappingError("INVALID_PREFERENCE", field, "Expected a serialized string");
  return utf8(value);
}
function numberValue(value: PhpValue | undefined, field: string, min: number, max: number): number {
  const candidate = Buffer.isBuffer(value) ? utf8(value) : typeof value === "boolean" ? Number(value) : value;
  if ((typeof candidate !== "number" && (typeof candidate !== "string" || !/^-?\d+$/.test(candidate))) || !Number.isSafeInteger(Number(candidate)) || Number(candidate) < min || Number(candidate) > max) throw new MappingError("INVALID_PREFERENCE", field, "Preference is outside its supported range");
  return Number(candidate);
}
const boolPrefs = {
  use_celsius: "useCelsius", new_window: "newWindow", unread_counts: "unreadCounts", item_excerpts: "itemExcerpts",
  auto_spark: "autoSpark", auto_read: "autoRead", mobile_read_on_scroll: "mobileReadOnScroll",
  mobile_read_on_back_out: "mobileReadOnBackOut", mobile_view_in_app: "mobileViewInApp", auto_reload: "autoReload",
  auto_refresh: "autoRefresh", auto_update: "autoUpdate", toggle_click: "toggleClick", anonymize: "anonymize", share: "share",
} as const;
const intPrefs = {
  refresh_interval: ["refreshInterval", 1, 1440], item_expiration: ["itemExpiration", 2, 10], layout: ["layout", 0, 1],
  item_allows: ["itemAllows", 0, 2], sort_order: ["sortOrder", 0, 1], per_page: ["perPage", 1, 200], session_timeout: ["sessionTimeout", 1, 1440],
} as const;
const sections: Record<number, Section> = { 0: "hot", 1: "kindling", 2: "saved", 3: "sparks", 4: "search" };
export interface MappedConfiguration {
  kind: "config"; id: number; email: string; emailBytes: Buffer; password: Buffer; version: number;
  preferences: Preferences; view: ViewState; installedAt: number; lastViewedAt: number; lastSessionAt: number;
  unknownKeys: string[];
}
function configuration(row: SnapshotRow): MappedConfiguration {
  const cfg = phpObject(decodePhp(bytes(row.fields.cfg, "cfg")));
  const prefs = phpObject(decodePhp(bytes(row.fields.prefs, "prefs")));
  const version = numberValue(cfg.version, "cfg.version", 1, 139);
  if (version < 125) throw new MappingError("UNSUPPORTED_SOURCE_VERSION", "cfg.version", "Versions below 125 require a separately reviewed offline data-shape conversion; source code is never executed by this importer");
  const emailBytes = cfg.email; const password = cfg.password;
  if (!Buffer.isBuffer(emailBytes) || !Buffer.isBuffer(password) || password.length > 4096) throw new MappingError("INVALID_CREDENTIAL", "cfg", "Owner credentials are missing or outside supported bounds");
  const email = utf8(emailBytes);
  if (!email || !email.includes("@") || emailBytes.length > 320 || /[\u0000-\u001f\u007f]/.test(email)) throw new MappingError("INVALID_EMAIL", "cfg.email", "Owner email cannot be used for authentication");
  // Preserve password bytes exactly; the browser can submit UTF-8 only.
  utf8(password);
  const preferences = createDefaultPreferences();
  const known = new Set(["ui", "services", "blacklist", ...Object.keys(boolPrefs), ...Object.keys(intPrefs)]);
  const unknownKeys = Object.keys(prefs).filter(key => !known.has(key)).map(key => `prefs.${key}`);
  for (const [source, target] of Object.entries(boolPrefs)) if (Object.hasOwn(prefs, source)) preferences[target] = numberValue(prefs[source], source, 0, 1) === 1;
  for (const [source, [target, min, max]] of Object.entries(intPrefs)) if (Object.hasOwn(prefs, source)) preferences[target] = numberValue(prefs[source], source, min, max);
  if (![2, 4, 6, 10].includes(preferences.itemExpiration)) throw new MappingError("INVALID_PREFERENCE", "item_expiration", "Unsupported expiration interval");
  if (Object.hasOwn(prefs, "blacklist")) preferences.blacklist = stringValue(prefs.blacklist, "blacklist");
  if (Object.hasOwn(prefs, "services")) {
    const services = prefs.services;
    if (!services || typeof services !== "object" || Buffer.isBuffer(services) || services.kind !== "array") throw new MappingError("INVALID_SERVICES", "services", "Expected an ordered services array");
    preferences.services = services.entries.map(([, value], index) => {
      const service = phpObject(value);
      for (const key of Object.keys(service)) if (!["name", "url", "key"].includes(key)) unknownKeys.push(`prefs.services.${index}.${key}`);
      const url = stringValue(service.url, "services.url");
      const destination = url.startsWith("#") ? url.slice(1) : url;
      let enabled = false;
      try {
        const parsed = new URL(destination);
        enabled = ["http:", "https:", ...(url.startsWith("#") ? [] : ["mailto:"])].includes(parsed.protocol) && !parsed.username && !parsed.password && !/[\u0000-\u001f\u007f]/.test(url);
      } catch { /* Preserve the original destination, visibly disabled. */ }
      const key = stringValue(service.key, "services.key");
      if (Array.from(key).length > 8) throw new MappingError("SERVICE_KEY_RANGE", "services.key", "Service key exceeds the target field bound; the original remains archived");
      if (key && !/^[a-z0-9]$/i.test(key)) enabled = false;
      return { name: stringValue(service.name, "services.name"), url, key, enabled, ...(!enabled ? { reason: "Imported destination or shortcut is unsupported. Original value is preserved." } : {}) };
    });
  }
  const view = createDefaultViewState();
  if (prefs.ui) {
    const ui = phpObject(prefs.ui);
    for (const key of Object.keys(ui)) if (!["section", "previous", "group_id", "feed_id", "search", "has_focus", "show_feeds", "show_read", "hot_start", "hot_range"].includes(key)) unknownKeys.push(`prefs.ui.${key}`);
    for (const key of ["section", "previous"] as const) if (Object.hasOwn(ui, key)) view[key] = sections[numberValue(ui[key], `ui.${key}`, 0, 4)];
    for (const [source, target, min, max] of [["group_id", "groupId", 0, 4_294_967_295], ["feed_id", "feedId", 0, 4_294_967_295], ["hot_start", "hotStart", 0, 36500], ["hot_range", "hotRange", 1, 36500]] as const) if (Object.hasOwn(ui, source)) view[target] = numberValue(ui[source], `ui.${source}`, min, max);
    for (const [source, target] of [["search", "search"], ["has_focus", "hasFocus"]] as const) if (Object.hasOwn(ui, source)) view[target] = stringValue(ui[source], `ui.${source}`);
    for (const [source, target] of [["show_feeds", "showFeeds"], ["show_read", "showRead"]] as const) if (Object.hasOwn(ui, source)) view[target] = numberValue(ui[source], `ui.${source}`, 0, 1) === 1;
  }
  for (const key of Object.keys(cfg)) if (!["email", "password", "version", "activation_key", "installed_on_time", "last_viewed_on_time", "last_session_on_time", "last_optimize_on_time", "last_repair_on_time", "updates"].includes(key)) unknownKeys.push(`cfg.${key}`);
  return { kind: "config", id: uint(row, "id", 1), email, emailBytes, password, version, preferences, view, unknownKeys,
    installedAt: numberValue(cfg.installed_on_time ?? 0, "installed_on_time", 0, 4_294_967_295), lastViewedAt: numberValue(cfg.last_viewed_on_time ?? 0, "last_viewed_on_time", 0, 4_294_967_295), lastSessionAt: numberValue(cfg.last_session_on_time ?? 0, "last_session_on_time", 0, 4_294_967_295) };
}
export function mapLegacyRow(row: SnapshotRow) {
  if (row.table === "_config") return configuration(row);
  if (row.table === "groups") return { kind: "group" as const, id: uint(row, "id", 1), title: text(row, "title")!, ...options(row) };
  if (row.table === "feeds_groups") return { kind: "membership" as const, feedId: uint(row, "feed_id", 1), groupId: uint(row, "group_id", 1) };
  if (row.table === "favicons") {
    const cache = text(row, "cache")!; const match = /^(?:data:)?(image\/(?:png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/=]*)$/.exec(cache);
    if (!match) throw new MappingError("INVALID_FAVICON", "cache", "Favicon is not a supported raster data string");
    const data = strictBase64(match[2], 1024 * 1024);
    const signatures = [data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), /^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii")), data[0] === 255 && data[1] === 216 && data[2] === 255, data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP", data.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))];
    const mimeIndex = ["image/png", "image/gif", "image/jpeg", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"].indexOf(match[1]);
    if (!signatures[Math.min(mimeIndex, 4)]) throw new MappingError("FAVICON_SIGNATURE", "cache", "Favicon bytes do not match the declared MIME type");
    return { kind: "favicon" as const, id: uint(row, "id", 1), data, mime: match[1], url: text(row, "url")!, checksum: uint(row, "url_checksum"), cachedAt: uint(row, "last_cached_on_time") };
  }
  if (row.table === "feeds") {
    const auth = text(row, "auth", true); const requiresAuth = flag(row, "requires_auth");
    const credential = auth ? strictBase64(auth, 16_384) : null;
    if (requiresAuth && !credential) throw new MappingError("MISSING_FEED_CREDENTIAL", "auth", "Authenticated source feed has no credential");
    if (credential && credential.indexOf(58) < 0) throw new MappingError("INVALID_FEED_CREDENTIAL", "auth", "Basic credential does not contain a username separator");
    if (credential) utf8(credential);
    return { kind: "feed" as const, id: uint(row, "id", 1), faviconId: uint(row, "favicon_id"), title: text(row, "title", true), url: text(row, "url")!, siteUrl: text(row, "site_url", true), domain: text(row, "domain", true), checksum: uint(row, "url_checksum"), requiresAuth, credential, isSpark: flag(row, "is_spark"), preventsHotlinking: flag(row, "prevents_hotlinking"), ...options(row), lastRefreshedAt: uint(row, "last_refreshed_on_time"), lastUpdatedAt: uint(row, "last_updated_on_time"), lastAddedAt: uint(row, "last_added_on_time") };
  }
  if (row.table === "items") return { kind: "item" as const, id: uint(row, "id", 1), feedId: uint(row, "feed_id", 1), uid: text(row, "uid", true), title: text(row, "title", true), author: text(row, "author", true), rawHtml: text(row, "description", true), url: text(row, "link", true), checksum: uint(row, "url_checksum"), readAt: uint(row, "read_on_time"), isSaved: flag(row, "is_saved"), publishedAt: uint(row, "created_on_time"), addedAt: uint(row, "added_on_time") };
  if (row.table === "links") return { kind: "link" as const, id: uint(row, "id", 1), feedId: uint(row, "feed_id", 1), itemId: uint(row, "item_id", 1), isBlacklisted: flag(row, "is_blacklisted"), isItem: flag(row, "is_item"), isLocal: flag(row, "is_local"), isFirst: flag(row, "is_first"), title: text(row, "title", true), url: text(row, "url", true), checksum: uint(row, "url_checksum"), titleChecksum: uint(row, "title_url_checksum"), weight: uint(row, "weight"), createdAt: uint(row, "created_on_time") };
  throw new MappingError("UNSUPPORTED_TABLE", "", "Unexpected legacy table");
}
export type MappedRow = ReturnType<typeof mapLegacyRow>;

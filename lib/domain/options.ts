import type { DisplayOptions, Preferences, SharingService, ViewState } from "../contracts";
import { defaultPreferences, defaultViewState, DISPLAY_KEYS, SECTIONS, PERSISTED_FOCUS, READER_LIMITS } from "../reader-policy";
export { DISPLAY_KEYS, SECTIONS, resolveDisplayOptions } from "../reader-policy";
import { DomainError, boolean, enumeration, integer, object, rejectUnknown, text } from "../validation";

export const DEFAULT_PREFERENCES = defaultPreferences;
export const DEFAULT_VIEW = defaultViewState;
const BOOL_KEYS = ["useCelsius", "newWindow", "unreadCounts", "itemExcerpts", "autoSpark", "autoRead", "mobileReadOnScroll", "mobileReadOnBackOut", "mobileViewInApp", "autoReload", "autoRefresh", "autoUpdate", "toggleClick", "anonymize", "share", "shareProtected"] as const;

export function displayOptions(input: Record<string, unknown>): Partial<DisplayOptions> {
  const result: Partial<DisplayOptions> = {};
  for (const key of DISPLAY_KEYS) {
    if (input[key] !== undefined) result[key] = enumeration(input[key], key, key === "itemAllows" ? [-1, 0, 1, 2] : [-1, 0, 1]);
  }
  return result;
}

function services(value: unknown): SharingService[] {
  if (!Array.isArray(value) || value.length > 50) throw new DomainError("Sharing services must be a list of at most 50 entries.");
  const seenKeys = new Set<string>();
  return value.map((entry) => {
    const row = object(entry, "service");
    rejectUnknown(row, ["id", "name", "url", "key", "enabled", "reason"]);
    const name = text(row.name, "name", 100, false).trim();
    const url = text(row.url, "url", 8192, false).trim();
    const key = text(row.key ?? "", "key", 1).toLowerCase();
    const requestedEnabled = row.enabled === undefined || boolean(row.enabled, "enabled");
    let reason: string | undefined;
    const probe = url.replace(/^#/, "").replace(/%[tue]/g, "value");
    try {
      const destination = new URL(probe);
      if (!["https:", "http:", "mailto:"].includes(destination.protocol) || destination.username || destination.password || /[\r\n]/.test(url)) reason = "Only HTTP, HTTPS, and mailto destinations without credentials are supported.";
      if (url.startsWith("#") && !["https:", "http:"].includes(destination.protocol)) reason = "Background services require an HTTP or HTTPS destination.";
    } catch { reason = "This service URL is invalid."; }
    if (key && !/^[a-z0-9]$/.test(key)) reason = "A shortcut must be one letter or number.";
    if (key && seenKeys.has(key)) reason = "This shortcut is already assigned to another sharing service.";
    if (key) seenKeys.add(key);
    return { ...(row.id === undefined ? {} : { id: integer(row.id, "id", 1) }), name, url, key, enabled: !reason && requestedEnabled, ...(reason ? { reason } : {}) };
  });
}

/** Partial saves merge with existing settings instead of resetting absent checkboxes. */
export function preferencePatch(value: unknown): Partial<Preferences> {
  const input = object(value);
  rejectUnknown(input, [...Object.keys(DEFAULT_PREFERENCES), "version"]);
  const patch: Partial<Preferences> = {};
  for (const key of BOOL_KEYS) if (input[key] !== undefined) patch[key] = boolean(input[key], key);
  if (input.refreshInterval !== undefined) patch.refreshInterval = integer(input.refreshInterval, "refreshInterval", 1, 1440);
  if (input.itemExpiration !== undefined) patch.itemExpiration = enumeration(input.itemExpiration, "itemExpiration", [2, 4, 6, 10]);
  if (input.perPage !== undefined) patch.perPage = integer(input.perPage, "perPage", 1, 200);
  if (input.sessionTimeout !== undefined) patch.sessionTimeout = integer(input.sessionTimeout, "sessionTimeout", 1, 1440);
  if (input.layout !== undefined) patch.layout = enumeration(input.layout, "layout", [0, 1]);
  if (input.itemAllows !== undefined) patch.itemAllows = enumeration(input.itemAllows, "itemAllows", [0, 1, 2]);
  if (input.sortOrder !== undefined) patch.sortOrder = enumeration(input.sortOrder, "sortOrder", [0, 1]);
  if (input.blacklist !== undefined) patch.blacklist = text(input.blacklist, "blacklist", 65536);
  if (input.services !== undefined) patch.services = services(input.services);
  return patch;
}

export function viewPatch(value: unknown): Partial<ViewState> {
  const input = object(value);
  rejectUnknown(input, [...Object.keys(DEFAULT_VIEW), "page", "cursor", "deviceKey"]);
  const patch: Partial<ViewState> = {};
  if (input.section !== undefined) patch.section = enumeration(input.section, "section", SECTIONS);
  if (input.previous !== undefined) patch.previous = enumeration(input.previous, "previous", SECTIONS);
  if (input.groupId !== undefined) patch.groupId = integer(input.groupId, "groupId");
  if (input.feedId !== undefined) patch.feedId = integer(input.feedId, "feedId");
  if (input.search !== undefined) patch.search = text(input.search, "search", READER_LIMITS.search);
  if (input.hasFocus !== undefined) patch.hasFocus = enumeration(input.hasFocus, "hasFocus", PERSISTED_FOCUS);
  if (input.showFeeds !== undefined) patch.showFeeds = boolean(input.showFeeds, "showFeeds");
  if (input.showRead !== undefined) patch.showRead = boolean(input.showRead, "showRead");
  if (input.hotStart !== undefined) patch.hotStart = integer(input.hotStart, "hotStart", 0, READER_LIMITS.hotStart);
  if (input.hotRange !== undefined) patch.hotRange = integer(input.hotRange, "hotRange", 1, READER_LIMITS.hotRange);
  return patch;
}

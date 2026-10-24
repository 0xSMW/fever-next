import type { DisplayOptions, Preferences, ViewState } from "./contracts";

export const SECTIONS = ["hot", "kindling", "saved", "sparks", "search"] as const;
export type Section = typeof SECTIONS[number];
export const PERSISTED_FOCUS = ["groups", "feeds", "items", "links", "article"] as const;
export type PersistedFocus = typeof PERSISTED_FOCUS[number];
export const DISPLAY_KEYS = ["itemExcerpts", "itemAllows", "unreadCounts", "sortOrder"] as const;
export const INHERITED_DISPLAY: DisplayOptions = { itemExcerpts: -1, itemAllows: -1, unreadCounts: -1, sortOrder: -1 };
export const READER_LIMITS = { search: 2048, hotStart: 36500, hotRange: 36500, deviceKey: 128 } as const;
export const HTTP_READER_LIMITS = { ...READER_LIMITS, search: 1000 } as const;
export const DEEP_LINK_LIMITS = { search: 1000, hotStart: 3650, hotRange: 366 } as const;
export function isDeviceKey(value: string): boolean { return /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
export function resolveDisplayOptions(preferences: Preferences, view: Pick<ViewState, "section" | "groupId">, group?: DisplayOptions, feed?: DisplayOptions): DisplayOptions {
  const result: DisplayOptions = { itemExcerpts: Number(preferences.itemExcerpts), itemAllows: preferences.itemAllows, unreadCounts: Number(preferences.unreadCounts), sortOrder: preferences.sortOrder };
  for (const key of DISPLAY_KEYS) {
    if (view.section === "kindling" && view.groupId && group && group[key] !== -1) result[key] = group[key];
    if (feed && feed[key] !== -1) result[key] = feed[key];
  }
  return result;
}

/** Fresh-install defaults preserve source preferences; autoUpdate is inert legacy metadata. */
export const defaultPreferences: Preferences = {
  useCelsius: false, refreshInterval: 15, itemExpiration: 10,
  newWindow: true, unreadCounts: false, layout: 0, itemExcerpts: true,
  itemAllows: 1, sortOrder: 0, autoSpark: false, perPage: 20,
  autoRead: true, mobileReadOnScroll: true, mobileReadOnBackOut: true,
  mobileViewInApp: true, autoReload: false, autoRefresh: true,
  autoUpdate: true, toggleClick: true, anonymize: false, sessionTimeout: 6,
  blacklist: "", share: false, shareProtected: false,
  services: [
    { name: "Email", url: "mailto:?subject=%t&body=%u", key: "e", enabled: true },
    { name: "Delicious", url: "http://delicious.com/save?url=%u&title=%t&v=5&noui=1&jump=doclose", key: "d", enabled: true },
    { name: "Instapaper", url: "http://instapaper.com/edit?url=%u&title=%t&summary=%e", key: "i", enabled: true },
    { name: "Twitter", url: "http://twitter.com/?status=%t%20%u", key: "t", enabled: true },
  ],
};
export const defaultViewState: ViewState = {
  section: "hot", previous: "hot", groupId: 0, feedId: 0, search: "", hasFocus: "groups",
  showFeeds: true, showRead: true, hotStart: 0, hotRange: 7,
};
export const DEFAULT_PREFERENCES = defaultPreferences;
export const DEFAULT_VIEW_STATE = defaultViewState;
export function createDefaultPreferences(): Preferences {
  return { ...defaultPreferences, services: defaultPreferences.services.map((service) => ({ ...service })) };
}
export function createDefaultViewState(): ViewState { return { ...defaultViewState }; }


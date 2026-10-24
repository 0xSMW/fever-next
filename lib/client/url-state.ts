import type { Section, ViewState } from "@/lib/contracts";
import { appHref } from "./api";
import { SECTIONS, DEEP_LINK_LIMITS, type PersistedFocus } from "../reader-policy";

/**
 * Reader deep links. Parameter names avoid the legacy root query words
 * (api, rss, refresh, manage, mobile, ...), which the manager rewrites.
 */
export type MobileScreen = "groups" | "feeds" | "items" | "article" | "hot";

export interface LocationState {
  view: Partial<ViewState>;
  /** True when the URL carried any reader parameter (a deep link). */
  explicit: boolean;
  compact: boolean | null;
  screen: MobileScreen | null;
  itemId: number;
  /**
   * Management dialog requested by lib/compat/root.ts (legacy ?manage=...
   * arrives as ?dialog=<kind>&feedId=<id>&groupId=<id>). The kind is checked
   * by the reader; readerHref never writes it back.
   */
  dialog: { kind: string; feedId: number; groupId: number } | null;
}

const SCREENS: MobileScreen[] = ["groups", "feeds", "items", "article", "hot"];

function int(value: string | null, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}
function flag(value: string | null): boolean | undefined {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

export function parseLocation(search: string): LocationState {
  const params = new URLSearchParams(search);
  const view: Partial<ViewState> = {};
  const section = params.get("section");
  if (section && (SECTIONS as readonly string[]).includes(section)) view.section = section as Section;
  const group = int(params.get("group"));
  if (group !== undefined) view.groupId = group;
  const feed = int(params.get("feed"));
  if (feed !== undefined) view.feedId = feed;
  const q = params.get("search");
  if (q !== null) view.search = q.slice(0, DEEP_LINK_LIMITS.search);
  const showRead = flag(params.get("showRead"));
  if (showRead !== undefined) view.showRead = showRead;
  const showFeeds = flag(params.get("showFeeds"));
  if (showFeeds !== undefined) view.showFeeds = showFeeds;
  const hotStart = int(params.get("hotStart"), 0, DEEP_LINK_LIMITS.hotStart);
  if (hotStart !== undefined) view.hotStart = hotStart;
  const hotRange = int(params.get("hotRange"), 1, DEEP_LINK_LIMITS.hotRange);
  if (hotRange !== undefined) view.hotRange = hotRange;
  const compactParam = params.has("mobile") ? true : flag(params.get("compact"));
  const screen = params.get("screen");
  const dialog = params.get("dialog");
  return {
    view,
    explicit: Object.keys(view).length > 0,
    compact: compactParam ?? null,
    screen: screen && (SCREENS as string[]).includes(screen) ? (screen as MobileScreen) : null,
    itemId: int(params.get("item"), 1) ?? 0,
    dialog: dialog && /^[a-z-]{1,40}$/.test(dialog)
      ? { kind: dialog, feedId: int(params.get("feedId"), 1) ?? 0, groupId: int(params.get("groupId"), 1) ?? 0 }
      : null,
  };
}

export interface HrefExtras { screen?: MobileScreen | null; itemId?: number; compact?: boolean | null; }

export function readerHref(view: ViewState, extras: HrefExtras = {}): string {
  const params = new URLSearchParams();
  params.set("section", view.section);
  if (view.section === "kindling" && view.groupId) params.set("group", String(view.groupId));
  if (view.section !== "hot" && view.feedId) params.set("feed", String(view.feedId));
  if (view.section === "search" || view.search) params.set("search", view.search);
  if (view.section === "hot") {
    params.set("hotStart", String(view.hotStart));
    params.set("hotRange", String(view.hotRange));
  } else {
    params.set("showRead", view.showRead ? "1" : "0");
    params.set("showFeeds", view.showFeeds ? "1" : "0");
  }
  if (extras.screen) params.set("screen", extras.screen);
  if (extras.itemId) params.set("item", String(extras.itemId));
  if (extras.compact === true) params.set("compact", "1");
  if (extras.compact === false) params.set("compact", "0");
  return `${appHref("/")}?${params.toString()}`;
}

/** Query for GET /api/reader; keys match lib/integrations/reader-query.ts. */
export function readerQueryString(view: ViewState, page = 1, cursor?: string | null): string {
  const params = new URLSearchParams();
  params.set("section", view.section);
  params.set("previous", view.previous);
  params.set("groupId", String(view.groupId));
  params.set("feedId", String(view.feedId));
  params.set("search", view.search);
  params.set("showRead", view.showRead ? "1" : "0");
  params.set("showFeeds", view.showFeeds ? "1" : "0");
  params.set("hotStart", String(view.hotStart));
  params.set("hotRange", String(view.hotRange));
  params.set("hasFocus", normalizeFocus(view.hasFocus));
  params.set("page", String(page));
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

/** View-state focus values accepted by the server (lib/domain/options.ts viewPatch). */
export function normalizeFocus(focus: string): PersistedFocus {
  if (focus === "groups" || focus === "feeds" || focus === "article" || focus === "items" || focus === "links") return focus;
  if (focus.startsWith("link-")) return "links";
  if (focus.startsWith("item-")) return "items";
  return "groups";
}

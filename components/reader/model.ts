import type { DisplayOptions, FeedDTO, GroupDTO, ItemDTO, Preferences, ReaderView, ViewState } from "@/lib/contracts";
import { resolveDisplayOptions } from "@/lib/reader-policy";
import { groupTitle } from "@/lib/client/format";

export type ItemStateClass = "saved" | "new" | "unread" | "read";

export function itemStateClass(item: Pick<ItemDTO, "isSaved" | "readAt" | "isNew">): ItemStateClass {
  if (item.isSaved) return "saved";
  if (!item.readAt) return item.isNew ? "new" : "unread";
  return "read";
}
export const STATE_LABELS: Record<ItemStateClass, string> = {
  saved: "Saved", new: "New", unread: "Unread", read: "Read",
};

/**
 * Global -> active custom group (Kindling only) -> feed, with -1 inheriting.
 * Shared with server rendering through the pure reader policy.
 */
export function resolveOption(
  key: keyof DisplayOptions, preferences: Preferences, view: Pick<ViewState, "section" | "groupId">,
  groups: GroupDTO[], feed?: Pick<FeedDTO, keyof DisplayOptions> | null,
): number {
  return resolveDisplayOptions(preferences, view, groups.find(g => g.id === view.groupId), feed ?? undefined)[key];
}

export function groupUnreadCountsVisible(preferences: Preferences, group: GroupDTO | null): boolean {
  if (group && group.unreadCounts !== -1) return group.unreadCounts === 1;
  return preferences.unreadCounts;
}

/**
 * The last refresh failed. A successful refresh stores its warnings in
 * lastError with fetchStatus "ok" (lib/ingest/persist.ts), and a failure
 * stores the error code as the status, so only a non-ok status is a failure.
 * Without fetchStatus (older payloads) any lastError counts as a failure.
 */
export function feedRefreshFailed(feed: Pick<FeedDTO, "lastError" | "fetchStatus">): boolean {
  if (!feed.lastError) return false;
  return feed.fetchStatus !== "ok";
}

export function feedMap(feeds: FeedDTO[]): Map<number, FeedDTO> {
  return new Map(feeds.map((feed) => [feed.id, feed]));
}

/** Kindling and custom group counts exclude Sparks; hidden memberships stay stored. */
export function groupMembers(group: GroupDTO, feeds: FeedDTO[]): FeedDTO[] {
  const ids = new Set(group.feedIds);
  return feeds.filter((feed) => !feed.isSpark && (ids.has(feed.id) || feed.groupIds.includes(group.id)));
}
export function groupUnread(group: GroupDTO, feeds: FeedDTO[]): number {
  return groupMembers(group, feeds).reduce((sum, feed) => sum + feed.unreadCount, 0);
}
export function kindlingUnread(feeds: FeedDTO[]): number {
  return feeds.reduce((sum, feed) => sum + (feed.isSpark ? 0 : feed.unreadCount), 0);
}
export function sparksUnread(feeds: FeedDTO[]): number {
  return feeds.reduce((sum, feed) => sum + (feed.isSpark ? feed.unreadCount : 0), 0);
}
export function savedTotal(data: ReaderView): number {
  return data.savedCount;
}

/**
 * Custom groups in the server's order (lib/domain/reader.ts sorts them as
 * MySQL did); the virtual Kindling group (id 0) is left out.
 */
export function sortedGroups(groups: GroupDTO[]): GroupDTO[] {
  return groups.filter((group) => group.id > 0);
}

/** Groups listed under Kindling; read groups hide unless showRead or selected. */
export function visibleGroups(data: ReaderView, view: ViewState): GroupDTO[] {
  return sortedGroups(data.groups).filter((group) =>
    view.showRead || groupUnread(group, data.feeds) > 0 || (view.section === "kindling" && view.groupId === group.id));
}

export type FeedCountLabel = "unread" | "saved" | "search";

export function feedCountLabel(view: ViewState): FeedCountLabel {
  return view.section === "saved" ? "saved" : view.section === "search" ? "search" : "unread";
}

/** The loaded data was computed for this section, group and search term. */
function sameScope(a: ViewState, b: ViewState): boolean {
  return a.section === b.section && a.groupId === b.groupId && a.search === b.search;
}

/**
 * The feeds pane for the current scope (reader/feeds.php). The server's
 * visibleFeedIds is used once it describes the current scope; Search matches
 * feed title/URL/site URL and item title/link/description there. The local
 * filters below cover the moment between navigation and the response.
 * Rows keep the server's data.feeds order (PHP's ksort on title and ID), so
 * nothing here re-sorts. data.feeds and data.groups stay complete for
 * management dialogs.
 */
export function scopeFeeds(data: ReaderView, view: ViewState): FeedDTO[] {
  if (view.section === "hot") return [];
  if (data.visibleFeedIds && sameScope(data.view, view)) {
    const ids = new Set(data.visibleFeedIds);
    // Spark memberships stay stored but are hidden in Kindling and custom groups.
    return data.feeds.filter((feed) => (ids.has(feed.id) || feed.id === view.feedId) && (view.section !== "kindling" || !feed.isSpark));
  }
  switch (view.section) {
    case "kindling":
      return view.groupId
        ? data.feeds.filter((feed) => !feed.isSpark && (feed.groupIds.includes(view.groupId)
          || data.groups.find((g) => g.id === view.groupId)?.feedIds.includes(feed.id)))
        : data.feeds.filter((feed) => !feed.isSpark);
    case "sparks":
      return data.feeds.filter((feed) => feed.isSpark);
    case "saved":
      return data.feeds.filter((feed) => feed.savedCount > 0 || feed.id === view.feedId);
    case "search":
      // The server matches with accent-folding LIKE, '%' and '_' wildcards
      // included, and the browser has no copy of that collation. Until
      // visibleFeedIds arrives for this term only the selected feed is
      // listed. The loaded items cannot stand in: here they belong to the
      // previous view (the desktop list) or are empty (the scoped mobile list).
      return data.feeds.filter((feed) => feed.id === view.feedId);
    default:
      return [];
  }
}

export function visibleScopeFeeds(data: ReaderView, view: ViewState): FeedDTO[] {
  const rows = scopeFeeds(data, view);
  if (view.showRead || view.section === "saved" || view.section === "search") return rows;
  return rows.filter((feed) => feed.unreadCount > 0 || feed.id === view.feedId);
}

/** Count shown on the virtual "All items" row. */
export function scopeTotal(data: ReaderView, view: ViewState, feeds: FeedDTO[]): number {
  if (view.section === "saved") return data.savedCount;
  if (view.section === "search") return data.searchCounts?.["0"] ?? data.totalItems;
  return feeds.reduce((sum, feed) => sum + feed.unreadCount, 0);
}

/** Search shows counts only when the server sent per-feed match counts. */
export function showsCounts(data: ReaderView, label: FeedCountLabel): boolean {
  return label !== "search" || data.searchCounts !== undefined;
}

/** Count shown on a feed row: saved items, search matches, or unread items. */
export function feedCount(data: ReaderView, label: FeedCountLabel, feed: FeedDTO): number {
  if (label === "saved") return feed.savedCount;
  if (label === "search") return data.searchCounts?.[String(feed.id)] ?? 0;
  return feed.unreadCount;
}

export function scopeTitle(data: ReaderView | null, view: ViewState): string {
  switch (view.section) {
    case "hot": return "Hot";
    case "saved": return "Saved";
    case "sparks": return "Sparks";
    case "search": return view.search ? `Search: ${view.search}` : "Search";
    default: {
      if (!view.groupId) return "Kindling";
      return groupTitle(data?.groups.find((g) => g.id === view.groupId));
    }
  }
}

/** Apply a read/saved change to every copy of an item (items and Hot sources). */
export function patchItemEverywhere<T extends { items: ItemDTO[]; links: ReaderView["links"] }>(
  state: T, itemId: number, patch: Partial<ItemDTO>,
): T {
  const items = state.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
  const links = state.links.map((link) => {
    const touchesSources = link.sources.some((source) => source.id === itemId);
    const linkPatch = link.itemId === itemId && link.isItem && patch.isSaved !== undefined ? { isSaved: patch.isSaved } : {};
    if (!touchesSources && !Object.keys(linkPatch).length) return link;
    return {
      ...link, ...linkPatch,
      sources: touchesSources ? link.sources.map((source) => (source.id === itemId ? { ...source, ...patch } : source)) : link.sources,
    };
  });
  return { ...state, items, links };
}

export function adjustFeedCounts(data: ReaderView, feedId: number, unreadDelta: number, savedDelta: number): ReaderView {
  if (!unreadDelta && !savedDelta) return data;
  const feed = data.feeds.find((row) => row.id === feedId);
  const feeds = data.feeds.map((row) => row.id === feedId ? {
    ...row,
    unreadCount: Math.max(0, row.unreadCount + unreadDelta),
    savedCount: Math.max(0, row.savedCount + savedDelta),
  } : row);
  const groups = feed && !feed.isSpark && unreadDelta ? data.groups.map((group) =>
    group.feedIds.includes(feedId) || feed.groupIds.includes(group.id)
      ? { ...group, unreadCount: Math.max(0, group.unreadCount + unreadDelta) } : group) : data.groups;
  return {
    ...data, feeds, groups,
    unreadCount: feed && !feed.isSpark ? Math.max(0, data.unreadCount + unreadDelta) : data.unreadCount,
    savedCount: Math.max(0, data.savedCount + savedDelta),
  };
}

/** Find a stored item by ID in the list or any Hot source list. */
export function findItem(items: ItemDTO[], links: ReaderView["links"], itemId: number, article?: ItemDTO | null): ItemDTO | undefined {
  return items.find((item) => item.id === itemId)
    ?? links.flatMap((link) => link.sources).find((source) => source.id === itemId)
    ?? (article?.id === itemId ? article : undefined);
}

/** Temperature groups in display order (links arrive ordered by the server). */
export function groupLinksByTemperature<T extends { temperature: number }>(links: T[], format: (value: number) => string): Array<{ degree: string; links: T[] }> {
  const groups: Array<{ degree: string; links: T[] }> = [];
  for (const link of links) {
    const degree = format(link.temperature);
    const last = groups[groups.length - 1];
    if (last && last.degree === degree) last.links.push(link);
    else groups.push({ degree, links: [link] });
  }
  return groups;
}

/** A standalone article stays outside ordered page rows and their cursors. */
export function patchArticle(article: ItemDTO | null, id: number, patch: Partial<ItemDTO>): ItemDTO | null {
  return article?.id === id ? { ...article, ...patch } : article;
}

import "server-only";
import { and, asc, desc, eq, gt, inArray, lt, lte, max, or, sql, type SQL } from "drizzle-orm";
import { legacyLike } from "../db/collation";
import type { FeedDTO, GroupDTO, ItemDTO, Preferences, ReaderQuery, ReaderView, ViewState } from "../contracts";
import { feedFetchState, feeds, groups, items, type FeedRow, type ItemRow } from "../db/schema";
import { epochNow, toCount } from "../db/numbers";
import { getConfig } from "../config";
import { contentUrl, excerpt, sanitizeContent } from "../ingest";
import { DomainError, integer } from "../validation";
import { cursorScope, decodeCursor, encodeCursor } from "./cursor";
import { getHotPage } from "./hot";
import { loadSubscriptionRows } from "./catalog";
import { INHERITED_DISPLAY } from "../reader-policy";
import { assertOwnerContext, withReaderSnapshot } from "./transaction";
import { resolveDisplayOptions, viewPatch } from "./options";
import { captureReaderView, deviceKey, getPreferences, getViewState } from "./preferences";
import type { DomainDb, OwnerContext } from "./types";

const inherited = INHERITED_DISPLAY;

function safeUrl(value: string) { return contentUrl(value) ?? ""; }
function attribute(value: string) { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

export function itemDTO(row: ItemRow, feed: FeedRow, preferences: Preferences, view: ViewState, group: GroupDTO | undefined, lastSessionAt: number): ItemDTO {
  const options = resolveDisplayOptions(preferences, view, group, feed);
  const baseUrl = safeUrl(row.url) || safeUrl(feed.siteUrl) || feed.url;
  let html = sanitizeContent(row.rawHtml || row.html, options.itemAllows, baseUrl);
  if (feed.preventsHotlinking) {
    const basePath = getConfig().basePath;
    html = html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (_match, prefix: string, source: string, suffix: string) => {
      const decoded = source.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      return `${prefix}${attribute(`${basePath}/api/media?itemId=${row.id}&url=${encodeURIComponent(decoded)}`)}${suffix}`;
    });
  }
  return {
    id: row.id, feedId: row.feedId, title: row.title, author: row.author, url: safeUrl(row.url),
    html, excerpt: excerpt(row.rawHtml || row.html), publishedAt: row.publishedAt, addedAt: row.addedAt,
    readAt: row.readAt, isSaved: row.isSaved, isNew: !row.isSaved && row.readAt === 0 && row.addedAt > lastSessionAt,
    feedTitle: feed.customTitle || feed.title || feed.url, faviconId: feed.faviconId ?? 0,
  };
}

async function navigation(owner: OwnerContext, db: DomainDb) {
  const { feedRows, groupRows, groupsByFeed, feedsByGroup } = await loadSubscriptionRows(owner, db);
  const fetchRows = await db.select({ state: feedFetchState }).from(feedFetchState).innerJoin(feeds, eq(feeds.id, feedFetchState.feedId)).where(eq(feeds.ownerId, owner.id));
  const fetchByFeed = new Map(fetchRows.map(({ state }) => [state.feedId, state]));
  const countRows = await db.select({ feedId: items.feedId, total: sql<string>`count(*)`, unread: sql<string>`count(*) filter (where ${items.readAt} = 0)`, saved: sql<string>`count(*) filter (where ${items.isSaved})` })
    .from(items).innerJoin(feeds, eq(feeds.id, items.feedId)).where(eq(feeds.ownerId, owner.id)).groupBy(items.feedId);
  const countMap = new Map(countRows.map((row) => [row.feedId, row]));
  const feedDTOs: FeedDTO[] = feedRows.map(feed => {
    const fetch = fetchByFeed.get(feed.id);
    return {
      id: feed.id, title: feed.customTitle || feed.title || feed.url, url: feed.url, siteUrl: safeUrl(feed.siteUrl), faviconId: feed.faviconId ?? 0,
      customTitle: feed.customTitle, sourceTitle: feed.title,
      groupIds: groupsByFeed.get(feed.id) ?? [],
      isSpark: feed.isSpark, requiresAuth: feed.requiresAuth, preventsHotlinking: feed.preventsHotlinking,
      itemExcerpts: feed.itemExcerpts, itemAllows: feed.itemAllows, unreadCounts: feed.unreadCounts, sortOrder: feed.sortOrder,
      unreadCount: toCount(countMap.get(feed.id)?.unread ?? 0), savedCount: toCount(countMap.get(feed.id)?.saved ?? 0), totalCount: toCount(countMap.get(feed.id)?.total ?? 0),
      lastRefreshedAt: fetch?.lastRefreshedAt ?? 0, lastUpdatedAt: fetch?.lastUpdatedAt ?? 0, lastError: fetch?.lastError ?? null, fetchStatus: fetch?.status ?? "pending",
    };
  });
  const groupDTOs: GroupDTO[] = groupRows.map((group) => {
    const memberIds = feedsByGroup.get(group.id) ?? [];
    const visible = feedDTOs.filter((feed) => memberIds.includes(feed.id) && !feed.isSpark);
    return { id: group.id, title: group.title, itemExcerpts: group.itemExcerpts, itemAllows: group.itemAllows, unreadCounts: group.unreadCounts, sortOrder: group.sortOrder,
      feedIds: memberIds, unreadCount: visible.reduce((n, feed) => n + feed.unreadCount, 0), totalCount: visible.reduce((n, feed) => n + feed.totalCount, 0) };
  });
  const kindling = feedDTOs.filter((feed) => !feed.isSpark);
  groupDTOs.unshift({ id: 0, title: "Kindling", ...inherited, feedIds: kindling.map((feed) => feed.id), unreadCount: kindling.reduce((n, feed) => n + feed.unreadCount, 0), totalCount: kindling.reduce((n, feed) => n + feed.totalCount, 0) });
  return { feedRows: new Map(feedRows.map(feed => [feed.id, feed])), feeds: feedDTOs, groups: groupDTOs };
}

/** Feed management and integrations must not advance a reading session or alter navigation. */
export async function getNavigation(owner: OwnerContext): Promise<{ feeds: FeedDTO[]; groups: GroupDTO[] }> {
  assertOwnerContext(owner);
  return withReaderSnapshot(owner, async (tx) => {
    const result = await navigation(owner, tx);
    return { feeds: result.feeds, groups: result.groups };
  });
}

/** Legacy wildcard semantics are deliberate: '%' and '_' remain SQL LIKE wildcards. */
function searchPredicate(search: string): SQL {
  const pattern = `%${search}%`;
  return or(legacyLike(items.title, pattern), legacyLike(items.url, pattern), legacyLike(items.rawHtml, pattern))!;
}

export async function getReaderView(owner: OwnerContext, query: ReaderQuery = {}, options: { capture?: boolean } = {}): Promise<ReaderView> {
  assertOwnerContext(owner);
  const requestedPage = query.page === undefined ? 1 : integer(query.page, "page", 1, 1000000);
  const preferences = await getPreferences(owner);
  let captured: Awaited<ReturnType<typeof captureReaderView>>;
  if (options.capture === false) {
    const patch = viewPatch(query);
    const key = deviceKey(query.deviceKey);
    const stored = await getViewState(owner, key);
    const view = { ...stored.view, ...patch };
    if (view.section !== "kindling") view.groupId = 0;
    captured = { view, lastSessionAt: stored.lastSessionAt, renderedAt: epochNow(), deviceKey: key };
  } else {
    captured = await captureReaderView(owner, query, preferences);
  }
  const { view, renderedAt, lastSessionAt } = captured;
  const data = await withReaderSnapshot(owner, async (tx) => {
    const nav = await navigation(owner, tx);
    const group = nav.groups.find((entry) => entry.id === view.groupId);
    if (!group) view.groupId = 0;
    let allowedFeeds = nav.feeds;
    if (view.section === "kindling") allowedFeeds = allowedFeeds.filter((feed) => !feed.isSpark && (!view.groupId || feed.groupIds.includes(view.groupId)));
    if (view.section === "sparks") allowedFeeds = allowedFeeds.filter((feed) => feed.isSpark);
    if (view.section === "saved") allowedFeeds = allowedFeeds.filter((feed) => feed.savedCount > 0);
    let searchCounts: Record<string, number> | undefined;
    if (view.section === "search") {
      searchCounts = {};
      if (!view.search) allowedFeeds = [];
      else {
        const pattern = `%${view.search}%`;
        const matching = await tx.select({ id: feeds.id }).from(feeds).where(and(eq(feeds.ownerId, owner.id), or(
          legacyLike(feeds.title, pattern), legacyLike(feeds.customTitle, pattern), legacyLike(feeds.url, pattern), legacyLike(feeds.siteUrl, pattern),
          inArray(feeds.id, tx.select({ id: items.feedId }).from(items).where(searchPredicate(view.search))),
        )));
        const matchingIds = new Set(matching.map((row) => row.id));
        allowedFeeds = allowedFeeds.filter((feed) => matchingIds.has(feed.id));
        const matches = await tx.select({ feedId: items.feedId, count: sql<string>`count(*)` }).from(items).innerJoin(feeds, eq(feeds.id, items.feedId))
          .where(and(eq(feeds.ownerId, owner.id), searchPredicate(view.search))).groupBy(items.feedId);
        for (const row of matches) searchCounts[String(row.feedId)] = toCount(row.count);
        searchCounts["0"] = matches.reduce((count, row) => count + toCount(row.count), 0);
      }
    }
    if (!allowedFeeds.some((feed) => feed.id === view.feedId)) view.feedId = 0;
    const selected = view.showFeeds && view.feedId ? [view.feedId] : allowedFeeds.map((feed) => feed.id);
    const options = resolveDisplayOptions(preferences, view, group, nav.feedRows.get(view.feedId));
    const base = and(eq(feeds.ownerId, owner.id), selected.length ? inArray(items.feedId, selected) : sql`false`,
      view.section === "saved" ? eq(items.isSaved, true) : undefined,
      view.section === "search" ? (view.search ? searchPredicate(view.search) : sql`false`) : undefined,
      (view.section === "kindling" || view.section === "sparks") && !view.showRead ? eq(items.readAt, 0) : undefined)!;
    const [counts] = await tx.select({ total: sql<string>`count(*)`, unread: sql<string>`count(*) filter (where ${items.readAt} = 0)`, saved: sql<string>`count(*) filter (where ${items.isSaved})` })
      .from(items).innerJoin(feeds, eq(items.feedId, feeds.id)).where(base);
    const common = { view, preferences, groups: nav.groups, feeds: nav.feeds, visibleFeedIds: allowedFeeds.map((feed) => feed.id), searchCounts, renderedAt, lastSessionAt,
      lastRefreshedAt: nav.feeds.reduce((latest, feed) => Math.max(latest, feed.lastRefreshedAt), 0),
      unreadCount: nav.groups[0].unreadCount, savedCount: nav.feeds.reduce((n, feed) => n + feed.savedCount, 0) };
    if (view.section === "hot") return { ...common, items: [], links: [], totalItems: 0, page: requestedPage, hasMore: false, nextCursor: null };
    const scope = cursorScope(owner.id, view, options.sortOrder);
    const cursor = query.cursor ? decodeCursor(query.cursor, scope) : undefined;
    const [latest] = cursor ? [{ id: cursor.snapshotId }] : await tx.select({ id: max(items.id) }).from(items).innerJoin(feeds, eq(items.feedId, feeds.id)).where(eq(feeds.ownerId, owner.id));
    const snapshotId = latest?.id ?? 0;
    const oldestFirst = options.sortOrder === 1;
    const after = cursor ? (oldestFirst
      ? or(gt(items.publishedAt, cursor.publishedAt), and(eq(items.publishedAt, cursor.publishedAt), gt(items.id, cursor.id)))
      : or(lt(items.publishedAt, cursor.publishedAt), and(eq(items.publishedAt, cursor.publishedAt), lt(items.id, cursor.id)))) : undefined;
    // Cursor continuation never uses OFFSET. Legacy page-only unread continuation restarts at zero.
    const shrinkingUnread = !view.showRead && (view.section === "kindling" || view.section === "sparks");
    const offset = cursor || shrinkingUnread ? 0 : (requestedPage - 1) * preferences.perPage;
    const rows = await tx.select({ item: items, feed: feeds }).from(items).innerJoin(feeds, eq(items.feedId, feeds.id))
      .where(and(base, lte(items.id, snapshotId), after)).orderBy(oldestFirst ? asc(items.publishedAt) : desc(items.publishedAt), oldestFirst ? asc(items.id) : desc(items.id))
      .limit(preferences.perPage + 1).offset(offset);
    const hasMore = rows.length > preferences.perPage;
    const pageRows = rows.slice(0, preferences.perPage);
    const last = pageRows.at(-1)?.item;
    const page = cursor ? cursor.page + 1 : requestedPage;
    return { ...common, items: pageRows.map(({ item, feed }) => itemDTO(item, feed, preferences, view, group, lastSessionAt)), links: [],
      totalItems: toCount(counts?.total ?? 0), page, hasMore,
      nextCursor: hasMore && last ? encodeCursor({ scope, snapshotId, publishedAt: last.publishedAt, id: last.id, page }) : null };
  });
  if (view.section === "hot") {
    const hot = await getHotPage(owner, { offset: view.hotStart, range: view.hotRange, page: requestedPage, perPage: preferences.perPage, useCelsius: preferences.useCelsius, lastSessionAt });
    return { ...data, links: hot.links, totalItems: hot.totalCandidates, hasMore: hot.hasMore };
  }
  return data;
}

export async function getItem(owner: OwnerContext, id: number, context: Pick<ReaderQuery, "deviceKey"> = {}): Promise<ItemDTO> {
  assertOwnerContext(owner);
  integer(id, "id", 1);
  return withReaderSnapshot(owner, async (tx) => {
    const [row] = await tx.select({ item: items, feed: feeds }).from(items).innerJoin(feeds, eq(items.feedId, feeds.id)).where(and(eq(items.id, id), eq(feeds.ownerId, owner.id))).limit(1);
    if (!row) throw new DomainError("Item not found.", "NOT_FOUND", 404);
    const preferences = await getPreferences(owner, tx);
    const { view, lastSessionAt } = await getViewState(owner, deviceKey(context.deviceKey), tx);
    const [group] = view.groupId ? await tx.select().from(groups).where(and(eq(groups.ownerId, owner.id), eq(groups.id, view.groupId))).limit(1) : [];
    return itemDTO(row.item, row.feed, preferences, view, group ? { ...group, feedIds: [], unreadCount: 0, totalCount: 0 } : undefined, lastSessionAt);
  });
}

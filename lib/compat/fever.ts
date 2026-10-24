import "server-only";
import { and, asc, desc, eq, gt, inArray, lt, sql, type SQL } from "drizzle-orm";
import { assertOwner, authenticateFeverDigest, type OwnerContext } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { feeds, feedFetchState, feedGroups, groups, favicons, items, readerViewState } from "@/lib/db/schema";
import { getPreferences, markScopeRead, mutateItems, undoRecentlyRead, updateFeed } from "@/lib/domain";
import { sanitizeContent } from "@/lib/ingest";
import { getHotPage } from "@/lib/domain/hot";
import { normalizeUrl } from "@/lib/legacy-url";
import { toCount, toEpochSeconds, toId } from "@/lib/db/numbers";
import { csvIds, HttpError, integer, privateHeaders, readText } from "@/lib/integrations/http";
import { feverXml, type FeverValue } from "./serialize";
import { logEvent } from "@/lib/observability/log";

function render(data: Record<string, FeverValue>, format: string | null, status = 200): Response {
  return new Response(format === "xml" ? feverXml(data) : JSON.stringify(data), { status, headers: { ...privateHeaders, Vary: "Accept", "Content-Type": format === "xml" ? "text/xml; charset=utf-8" : "text/json; charset=utf-8" } });
}

async function mutation(owner: OwnerContext, form: URLSearchParams, flags: URLSearchParams): Promise<void> {
  const mark = form.get("mark"), as = form.get("as"), rawId = form.get("id");
  if (mark !== null && as !== null && rawId !== null) {
    const allowed = new Set(["item:read", "item:unread", "item:saved", "item:unsaved", "feed:read", "group:read", "feed:spark", "feed:unspark", "link:saved", "link:unsaved"]);
    const command = `${mark}:${as}`;
    // Unsupported legacy methods were ignored. Never derive a callable method name.
    if (allowed.has(command)) {
      const id = integer(rawId, "id", mark === "group" ? -1 : 0);
      try {
      if (mark === "item") {
        if (id > 0) await mutateItems(owner, as === "saved" ? "save" : as === "unsaved" ? "unsave" : as as "read" | "unread", [id], { origin: "api" });
      } else if (as === "read") {
        // Missing/zero before cannot match nonnegative added timestamps in the source.
        const before = form.has("before") ? integer(form.get("before"), "before") : 0;
        if (before > 0 && (mark === "group" || id > 0)) await markScopeRead(owner, { scope: mark === "feed" ? "feed" : id === -1 ? "sparks" : id === 0 ? "all" : "group", ...(id > 0 ? { id } : {}), before }, "api");
      } else if (mark === "feed" && id > 0) {
        const [feed] = await getDb().select({ url: feeds.url }).from(feeds).where(and(eq(feeds.ownerId, owner.id), eq(feeds.id, id))).limit(1);
        if (feed) await updateFeed(owner, { id, isSpark: as === "spark" }, "api");
      }
      } catch (error) {
        // Legacy clients can replay an item/feed/group already deleted on another client.
        if (!(error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND")) throw error;
      }
      // link saved/unsaved intentionally have no mutation: both source methods are empty.
      if (as === "read" || as === "unread") flags.set("unread_item_ids", "");
      if (as === "saved" || as === "unsaved") flags.set("saved_item_ids", "");
    }
  }
  if (form.has("unread_recently_read")) {
    const [view] = await getDb().select({ section: readerViewState.section }).from(readerViewState).where(and(eq(readerViewState.ownerId, owner.id), eq(readerViewState.deviceId, "default"))).limit(1);
    await undoRecentlyRead(owner, view?.section ?? "hot", "api");
    flags.set("unread_item_ids", "");
  }
}

export async function handleFever(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const format = query.get("api");
  const data: Record<string, FeverValue> = { api_version: 3, auth: 0 };
  try {
  if (request.method !== "POST") return render(data, format);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].toLowerCase().trim();
  if (contentType !== "application/x-www-form-urlencoded") return render(data, format);
  const form = new URLSearchParams(await readText(request, 65_536));
  if (form.getAll("api_key").length !== 1) return render(data, format);
  const owner = await authenticateFeverDigest(form.get("api_key")!, request);
  if (!owner) return render(data, format);
  data.auth = 1;
  await assertOwner(owner);
  if (request.url.length > 131_072) throw new HttpError("The API query is too large.", 414, "QUERY_TOO_LARGE");
  await mutation(owner, form, query);
  const db = getDb();
  const [latest] = await db.select({ value: sql<string | null>`max(${feedFetchState.lastRefreshedAt})` }).from(feedFetchState).innerJoin(feeds, eq(feeds.id, feedFetchState.feedId)).where(eq(feeds.ownerId, owner.id));
  // Source get_col() returns false when there are no subscriptions; a real
  // unrefreshed feed still has the numeric epoch zero.
  data.last_refreshed_on_time = latest?.value == null ? false : toEpochSeconds(latest.value);
  if (query.has("groups")) {
    data.groups = (await db.select({ id: groups.id, title: groups.title }).from(groups).where(eq(groups.ownerId, owner.id)).orderBy(asc(groups.id))).map(row => ({ id: toId(row.id), title: row.title }));
  }
  if (query.has("groups") || query.has("feeds")) {
    const memberships = await db.select({ groupId: feedGroups.groupId, feedId: feedGroups.feedId }).from(feedGroups).innerJoin(feeds, eq(feeds.id, feedGroups.feedId)).innerJoin(groups, eq(groups.id, feedGroups.groupId)).where(and(eq(feeds.ownerId, owner.id), eq(groups.ownerId, owner.id), eq(feeds.isSpark, false))).orderBy(asc(feedGroups.groupId), asc(feedGroups.feedId));
    const byGroup = new Map<number, number[]>();
    for (const row of memberships) { const members = byGroup.get(row.groupId) ?? []; members.push(toId(row.feedId)); byGroup.set(toId(row.groupId), members); }
    data.feeds_groups = [...byGroup].map(([group_id, ids]) => ({ group_id, feed_ids: ids.join(",") }));
    if (query.has("feeds")) data.feeds = (await db.select({ feed: feeds, state: feedFetchState }).from(feeds).leftJoin(feedFetchState, eq(feeds.id, feedFetchState.feedId)).where(eq(feeds.ownerId, owner.id)).orderBy(asc(feeds.id))).map(({ feed, state }) => ({
      id: toId(feed.id), favicon_id: feed.faviconId ? toId(feed.faviconId) : 1, title: feed.customTitle || feed.title || normalizeUrl(feed.url), url: feed.url, site_url: feed.siteUrl, is_spark: feed.isSpark ? 1 : 0, last_updated_on_time: toEpochSeconds(state?.lastUpdatedAt ?? 0),
    }));
  }
  if (query.has("favicons")) data.favicons = (await db.select().from(favicons).where(eq(favicons.ownerId, owner.id)).orderBy(asc(favicons.id))).map(icon => ({ id: toId(icon.id), data: `${icon.mimeType};base64,${icon.data.toString("base64")}` }));
  if (query.has("items")) {
    const [total] = await db.select({ value: sql<string>`count(*)` }).from(items).innerJoin(feeds, eq(feeds.id, items.feedId)).where(eq(feeds.ownerId, owner.id));
    data.total_items = toCount(total?.value ?? 0);
    const conditions: SQL[] = [eq(feeds.ownerId, owner.id)];
    if (query.has("feed_ids") || query.has("group_ids")) {
      const selectedFeeds = new Set(csvIds(query.get("feed_ids"), "feed_ids", true));
      const groupIds = csvIds(query.get("group_ids"), "group_ids", true);
      if (groupIds.length) {
        const members = await db.select({ feedId: feedGroups.feedId }).from(feedGroups).innerJoin(groups, eq(groups.id, feedGroups.groupId)).where(and(eq(groups.ownerId, owner.id), inArray(feedGroups.groupId, groupIds)));
        members.forEach(member => selectedFeeds.add(toId(member.feedId)));
      }
      conditions.push(selectedFeeds.size ? inArray(items.feedId, [...selectedFeeds]) : sql`false`);
    }
    let descending = false;
    if (query.has("max_id")) { const id = integer(query.get("max_id"), "max_id"); if (id) conditions.push(lt(items.id, id)); descending = true; }
    else if (query.has("with_ids")) { const ids = csvIds(query.get("with_ids"), "with_ids", true); conditions.push(ids.length ? inArray(items.id, ids) : sql`false`); }
    else { const id = query.has("since_id") ? integer(query.get("since_id"), "since_id") : 0; if (id) conditions.push(gt(items.id, id)); }
    data.items = (await db.select({ item: items }).from(items).innerJoin(feeds, eq(feeds.id, items.feedId)).where(and(...conditions)).orderBy(descending ? desc(items.id) : asc(items.id)).limit(50)).map(({ item }) => ({
      id: toId(item.id), feed_id: toId(item.feedId), title: item.title, author: item.author, html: sanitizeContent(item.rawHtml || item.html, "rich", item.url), url: item.url, is_saved: item.isSaved ? 1 : 0, is_read: item.readAt ? 1 : 0, created_on_time: toEpochSeconds(item.publishedAt),
    }));
  }
  if (query.has("links")) {
    const prefs = await getPreferences(owner);
    const hot = await getHotPage(owner, { offset: query.has("offset") ? integer(query.get("offset"), "offset", 0, 36500) : 0, range: query.has("range") ? integer(query.get("range"), "range", 1, 36500) : 7, page: query.has("page") ? integer(query.get("page"), "page", 1, 1_000_000) : 1, perPage: prefs.perPage, useCelsius: prefs.useCelsius });
    data.use_celsius = prefs.useCelsius ? 1 : 0;
    data.links = hot.links.map(link => ({ id: toId(link.id), feed_id: toId(link.feedId), item_id: toId(link.itemId), temperature: link.temperature, is_item: link.isItem ? 1 : 0, is_local: link.isLocal ? 1 : 0, is_saved: link.isSaved ? 1 : 0, title: link.title, url: link.url, item_ids: link.itemIds.map(id => toId(id)).join(",") }));
  }
  for (const [flag, predicate] of [["unread_item_ids", eq(items.readAt, 0)], ["saved_item_ids", eq(items.isSaved, true)]] as const) {
    if (query.has(flag)) {
      // Complete sets, without the 50-item detail limit or reader pagination.
      const [result] = await db.select({ ids: sql<string>`coalesce(string_agg(${items.id}::text, ',' order by ${items.id}), '')` }).from(items).innerJoin(feeds, eq(feeds.id, items.feedId)).where(and(eq(feeds.ownerId, owner.id), predicate));
      data[flag] = result?.ids ?? "";
    }
  }
  return render(data, format);
  } catch (error) {
    const known = error instanceof Error && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status <= 503 && "code" in error && typeof error.code === "string";
    const failure = error as Error & { code?: string; status?: number; retryAfter?: number };
    logEvent("fever.request_failed", { code: known ? failure.code : "INTERNAL_ERROR", status: known ? failure.status : 500 });
    const response = render({ api_version: 3, auth: data.auth, error: known ? failure.message : "The request could not be completed.", code: known ? failure.code! : "INTERNAL_ERROR" }, format, known ? failure.status : 500);
    if (known && failure.retryAfter) response.headers.set("Retry-After", String(failure.retryAfter));
    return response;
  }
}

import "server-only";
import { and, eq } from "drizzle-orm";
import { feeds, groups, feedGroups } from "../db/schema";
import { legacySortFeeds, legacyTextCompare } from "../db/collation";
import { contentUrl } from "../ingest/content";
import { DomainError } from "../validation";
import { withReaderSnapshot } from "./transaction";
import type { DomainDb, OwnerContext } from "./types";

/** Shared owner-scoped rows; no item aggregate or fetch-state query. */
export async function loadSubscriptionRows(owner: OwnerContext, db: DomainDb) {
  const rows = await db.select().from(feeds).where(eq(feeds.ownerId, owner.id));
  rows.sort((a, b) => legacyTextCompare(a.title, b.title) || legacyTextCompare(a.url, b.url) || a.id - b.id);
  const feedRows = legacySortFeeds(rows);
  const groupRows = await db.select().from(groups).where(eq(groups.ownerId, owner.id));
  groupRows.sort((a, b) => legacyTextCompare(a.title, b.title) || a.id - b.id);
  const memberships = await db.select({ feedId: feedGroups.feedId, groupId: feedGroups.groupId }).from(feedGroups)
    .innerJoin(feeds, eq(feeds.id, feedGroups.feedId)).innerJoin(groups, eq(groups.id, feedGroups.groupId))
    .where(and(eq(feeds.ownerId, owner.id), eq(groups.ownerId, owner.id)));
  const groupsByFeed = new Map<number, number[]>(), feedsByGroup = new Map<number, number[]>();
  for (const { feedId, groupId } of memberships) {
    const ids = groupsByFeed.get(feedId) ?? []; ids.push(groupId); groupsByFeed.set(feedId, ids);
    const members = feedsByGroup.get(groupId) ?? []; members.push(feedId); feedsByGroup.set(groupId, members);
  }
  return { feedRows, groupRows, groupsByFeed, feedsByGroup };
}
export async function getSubscriptionCatalog(owner: OwnerContext) {
  return withReaderSnapshot(owner, async tx => {
    const { feedRows, groupRows, groupsByFeed, feedsByGroup } = await loadSubscriptionRows(owner, tx);
    return {
      feeds: feedRows.map(feed => ({ id: feed.id, title: feed.customTitle || feed.title || feed.url, url: feed.url,
        siteUrl: contentUrl(feed.siteUrl) ?? "", isSpark: feed.isSpark, groupIds: groupsByFeed.get(feed.id) ?? [] })),
      groups: groupRows.map(group => ({ id: group.id, title: group.title, feedIds: feedsByGroup.get(group.id) ?? [] })),
    };
  });
}
export type SubscriptionCatalog = Awaited<ReturnType<typeof getSubscriptionCatalog>>;
export async function getFeedIdentity(owner: OwnerContext, id: number): Promise<{ id: number; isSpark: boolean }> {
  return withReaderSnapshot(owner, async tx => {
    const [feed] = await tx.select({ id: feeds.id, isSpark: feeds.isSpark }).from(feeds).where(and(eq(feeds.ownerId, owner.id), eq(feeds.id, id))).limit(1);
    if (!feed) throw new DomainError("This feed no longer exists.", "FEED_NOT_FOUND", 404);
    return feed;
  });
}

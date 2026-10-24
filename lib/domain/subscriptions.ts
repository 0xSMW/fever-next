import "server-only";
import type { CreateFeedResult } from "../command-contract";
import { and, eq, inArray, sql } from "drizzle-orm";
import { legacyTextEqual } from "../db/collation";
import { feedCredentials, feedFetchState, feedGroups, feeds, groups, itemIdentityAliases, items, linkOccurrences } from "../db/schema";
import { encryptSecret, encryptionKeyId } from "../crypto";
import { canonicalUrlKey, checksum, normalizeUrl } from "../legacy-url";
import { DomainError, boolean, confirmed, ids, integer, object, rejectUnknown, text } from "../validation";
import { parseFeedInput, parseGroupInput } from "./input";
import { journal } from "./journal";
import { assertOwnerContext, withDomainMutation } from "./transaction";
import { getPreferences, resetRemovedSelection } from "./preferences";
import type { DomainDb, MutationOrigin, OwnerContext } from "./types";

async function ownFeeds(db: DomainDb, owner: OwnerContext, selection: number[]) {
  if (!selection.length) return [];
  const rows = await db.select().from(feeds).where(and(eq(feeds.ownerId, owner.id), inArray(feeds.id, selection))).orderBy(feeds.id).for("update");
  if (rows.length !== selection.length) throw new DomainError("One or more feeds no longer exist.", "NOT_FOUND", 404);
  return rows;
}
async function ownGroups(db: DomainDb, owner: OwnerContext, selection: number[]) {
  if (!selection.length) return [];
  const rows = await db.select().from(groups).where(and(eq(groups.ownerId, owner.id), inArray(groups.id, selection))).orderBy(groups.id).for("update");
  if (rows.length !== selection.length) throw new DomainError("One or more groups no longer exist.", "NOT_FOUND", 404);
  return rows;
}

async function snapshotFeeds(db: DomainDb, owner: OwnerContext, selection: number[], includeContent = false) {
  const owned = await ownFeeds(db, owner, selection);
  if (!selection.length) return { feeds: [], feedGroups: [], feedFetchState: [], feedCredentials: [], items: [], linkOccurrences: [], itemIdentityAliases: [] };
  return {
    feeds: owned,
    feedGroups: await db.select().from(feedGroups).where(inArray(feedGroups.feedId, selection)),
    feedFetchState: await db.select().from(feedFetchState).where(inArray(feedFetchState.feedId, selection)),
    feedCredentials: await db.select().from(feedCredentials).where(inArray(feedCredentials.feedId, selection)),
    ...(includeContent ? {
      items: await db.select().from(items).where(inArray(items.feedId, selection)).orderBy(items.id).for("update"),
      linkOccurrences: await db.select().from(linkOccurrences).where(inArray(linkOccurrences.feedId, selection)),
      itemIdentityAliases: await db.select().from(itemIdentityAliases).where(inArray(itemIdentityAliases.feedId, selection)),
    } : {}),
  };
}

async function replaceFeedGroups(db: DomainDb, owner: OwnerContext, feedId: number, groupIds: number[]) {
  await ownGroups(db, owner, groupIds);
  await db.delete(feedGroups).where(eq(feedGroups.feedId, feedId));
  if (groupIds.length) await db.insert(feedGroups).values(groupIds.map((groupId) => ({ feedId, groupId }))).onConflictDoNothing();
}

async function writeCredentials(db: DomainDb, feedId: number, input: { username?: string; password?: string; clearCredentials?: boolean }) {
  if (input.clearCredentials) {
    if (input.username || input.password) throw new DomainError("Choose either replacement credentials or clearing credentials.");
    await db.delete(feedCredentials).where(eq(feedCredentials.feedId, feedId));
    await db.update(feeds).set({ requiresAuth: false, updatedAt: new Date() }).where(eq(feeds.id, feedId));
  } else if (input.username !== undefined || input.password !== undefined) {
    if (input.username === undefined || input.password === undefined) throw new DomainError("Enter both the username and password to replace feed credentials.");
    if (input.username.includes(":")) throw new DomainError("A Basic authentication username cannot contain a colon.");
    // Passwords retain all whitespace. A blank edit form leaves credentials unchanged.
    if (!input.username && !input.password) return;
    const ciphertext = encryptSecret(JSON.stringify({ username: input.username, password: input.password }), `feed:${feedId}`);
    await db.insert(feedCredentials).values({ feedId, ciphertext, keyId: encryptionKeyId(ciphertext) })
      .onConflictDoUpdate({ target: feedCredentials.feedId, set: { ciphertext, keyId: encryptionKeyId(ciphertext), lastAuthError: null, updatedAt: new Date() } });
    await db.update(feeds).set({ requiresAuth: true, updatedAt: new Date() }).where(eq(feeds.id, feedId));
  } else return;
  await db.insert(feedFetchState).values({ feedId }).onConflictDoUpdate({ target: feedFetchState.feedId, set: { nextAttemptAt: 0, lastError: null, status: "pending", fence: sql`${feedFetchState.fence} + 1`, updatedAt: new Date() } });
}

export async function createFeed(owner: OwnerContext, payload: unknown): Promise<CreateFeedResult> {
  assertOwnerContext(owner);
  const input = parseFeedInput(payload);
  const url = input.url;
  const canonicalUrl = normalizeUrl(url);
  const urlKey = canonicalUrlKey(canonicalUrl);
  return withDomainMutation(owner, "subscriptions", async (tx) => {
    await ownGroups(tx, owner, input.groupIds ?? []);
    const [existing] = await tx.select().from(feeds).where(and(eq(feeds.ownerId, owner.id), eq(feeds.urlKey, urlKey))).for("update");
    if (existing) {
      if (existing.canonicalUrl !== canonicalUrl) throw new DomainError("A URL identity collision requires operator review.", "IDENTITY_COLLISION", 409);
      const before = await snapshotFeeds(tx, owner, [existing.id]);
      const added = input.groupIds?.length ? await tx.insert(feedGroups).values(input.groupIds.map((groupId) => ({ feedId: existing.id, groupId }))).onConflictDoNothing().returning() : [];
      const after = await snapshotFeeds(tx, owner, [existing.id]);
      await journal(tx, owner, "feed.subscribe-existing", before, after, [existing.id]);
      return { id: existing.id, created: false, membershipsAdded: added.length };
    }
    const preferences = await getPreferences(owner, tx);
    const { groupIds, username, password, clearCredentials, ...fields } = input;
    const [feed] = await tx.insert(feeds).values({ ...fields, ownerId: owner.id, url, originalUrl: url, canonicalUrl, urlKey, urlChecksum: checksum(canonicalUrl),
      title: input.title ?? "", customTitle: input.title || null, domain: new URL(url).hostname, isSpark: input.isSpark ?? preferences.autoSpark }).returning();
    await tx.insert(feedFetchState).values({ feedId: feed.id });
    const added = groupIds?.length ? await tx.insert(feedGroups).values(groupIds.map((groupId) => ({ feedId: feed.id, groupId }))).returning() : [];
    await writeCredentials(tx, feed.id, { username, password, clearCredentials });
    const after = await snapshotFeeds(tx, owner, [feed.id]);
    const operationId = await journal(tx, owner, "feed.create", {}, after, [feed.id]);
    return { id: feed.id, created: true, membershipsAdded: added.length, operationId };
  });
}

export async function updateFeed(owner: OwnerContext, payload: unknown, origin: MutationOrigin = "ui") {
  assertOwnerContext(owner);
  const input = parseFeedInput(payload, true);
  const id = input.id;
  return withDomainMutation(owner, "subscriptions", async (tx) => {
    const before = await snapshotFeeds(tx, owner, [id]);
    const previous = before.feeds[0];
    const { id: _id, groupIds, username, password, clearCredentials, title, ...fields } = input;
    void _id;
    const changes: Partial<typeof feeds.$inferInsert> = { ...fields, updatedAt: new Date() };
    if (title !== undefined) changes.customTitle = title || null;
    if (input.url !== undefined && input.url !== previous.url) {
      const canonicalUrl = normalizeUrl(input.url);
      const key = canonicalUrlKey(canonicalUrl);
      const [duplicate] = await tx.select({ id: feeds.id }).from(feeds).where(and(eq(feeds.ownerId, owner.id), eq(feeds.urlKey, key)));
      if (duplicate && duplicate.id !== id) throw new DomainError("This feed is already subscribed. Edit its memberships instead.", "DUPLICATE_FEED", 409);
      Object.assign(changes, { canonicalUrl, urlKey: key, urlChecksum: checksum(canonicalUrl), domain: new URL(input.url).hostname });
      // In-flight work must fail its fence check instead of applying content from the old URL.
      await tx.update(feedFetchState).set({ fence: sql`${feedFetchState.fence} + 1`, nextAttemptAt: 0, etag: null, lastModified: null, finalUrl: null, status: "pending", updatedAt: new Date() }).where(eq(feedFetchState.feedId, id));
    }
    await tx.update(feeds).set(changes).where(and(eq(feeds.ownerId, owner.id), eq(feeds.id, id)));
    if (groupIds !== undefined) await replaceFeedGroups(tx, owner, id, groupIds);
    await writeCredentials(tx, id, { username, password, clearCredentials });
    const operationId = await journal(tx, owner, "feed.update", before, await snapshotFeeds(tx, owner, [id]), [id], origin);
    return { id, operationId };
  });
}

export async function authenticateFeed(owner: OwnerContext, payload: unknown) {
  const input = object(payload);
  rejectUnknown(input, ["id", "username", "password", "clearCredentials"]);
  if (input.clearCredentials !== true && !input.username && !input.password) throw new DomainError("Enter feed credentials, or explicitly clear the stored credentials.");
  return updateFeed(owner, { id: integer(input.id, "id", 1),
    ...(input.clearCredentials === undefined ? {} : { clearCredentials: boolean(input.clearCredentials, "clearCredentials") }),
    ...(input.username === undefined ? {} : { username: text(input.username, "username", 4096) }),
    ...(input.password === undefined ? {} : { password: text(input.password, "password", 16384) }) });
}

export async function deleteFeed(owner: OwnerContext, payload: unknown) {
  assertOwnerContext(owner);
  const input = object(payload);
  rejectUnknown(input, ["id", "confirm"]);
  const id = integer(input.id, "id", 1);
  confirmed(input.confirm);
  return withDomainMutation(owner, "subscriptions", async (tx) => {
    const before = await snapshotFeeds(tx, owner, [id], true);
    await tx.delete(feeds).where(and(eq(feeds.ownerId, owner.id), eq(feeds.id, id)));
    await resetRemovedSelection(tx, owner, [id]);
    const operationId = await journal(tx, owner, "feed.delete", before, {}, [id]);
    return { deleted: 1, itemsDeleted: before.items?.length ?? 0, savedItemsDeleted: before.items?.filter((item) => item.isSaved).length ?? 0, operationId };
  });
}

export async function createGroup(owner: OwnerContext, payload: unknown) {
  assertOwnerContext(owner);
  const input = parseGroupInput(payload);
  return withDomainMutation(owner, "subscriptions", async (tx) => {
    await ownFeeds(tx, owner, input.feedIds ?? []);
    if (input.title.toLowerCase() === "kindling") return { id: 0, created: false };
    const candidates = await tx.select({ id: groups.id, title: groups.title }).from(groups).where(eq(groups.ownerId, owner.id)).orderBy(groups.id);
    const existing = candidates.find(group => legacyTextEqual(group.title, input.title));
    if (existing) return { id: existing.id, created: false };
    const { feedIds, ...fields } = input;
    const [group] = await tx.insert(groups).values({ ownerId: owner.id, ...fields }).returning();
    const memberships = (feedIds ?? []).map((feedId) => ({ feedId, groupId: group.id }));
    if (memberships.length) await tx.insert(feedGroups).values(memberships);
    const operationId = await journal(tx, owner, "group.create", {}, { groups: [group], feedGroups: memberships }, [group.id]);
    return { id: group.id, created: true, operationId };
  });
}

export async function updateGroup(owner: OwnerContext, payload: unknown) {
  assertOwnerContext(owner);
  const input = parseGroupInput(payload, true);
  if (input.title.toLowerCase() === "kindling") throw new DomainError("Kindling is the built-in group and cannot be used as a custom group name.");
  const id = input.id;
  return withDomainMutation(owner, "subscriptions", async (tx) => {
    const previous = await ownGroups(tx, owner, [id]);
    const candidates = await tx.select({ id: groups.id, title: groups.title }).from(groups).where(eq(groups.ownerId, owner.id));
    const duplicate = candidates.find(group => group.id !== id && legacyTextEqual(group.title, input.title));
    if (duplicate) throw new DomainError("A group with this name already exists.", "DUPLICATE_GROUP", 409);
    const beforeMemberships = await tx.select().from(feedGroups).where(eq(feedGroups.groupId, id));
    const { feedIds, id: _id, ...fields } = input;
    void _id;
    await ownFeeds(tx, owner, feedIds ?? []);
    const [group] = await tx.update(groups).set({ ...fields, updatedAt: new Date() }).where(and(eq(groups.ownerId, owner.id), eq(groups.id, id))).returning();
    if (feedIds !== undefined) {
      await tx.delete(feedGroups).where(eq(feedGroups.groupId, id));
      if (feedIds.length) await tx.insert(feedGroups).values(feedIds.map((feedId) => ({ feedId, groupId: id })));
    }
    const operationId = await journal(tx, owner, "group.update", { groups: previous, feedGroups: beforeMemberships }, { groups: [group], feedGroups: await tx.select().from(feedGroups).where(eq(feedGroups.groupId, id)) }, [id]);
    return { id, operationId };
  });
}

export async function deleteGroup(owner: OwnerContext, payload: unknown) {
  assertOwnerContext(owner);
  const input = object(payload);
  rejectUnknown(input, ["id", "unsubscribe", "confirm"]);
  const id = integer(input.id, "id", 1);
  const unsubscribe = input.unsubscribe === undefined ? false : boolean(input.unsubscribe, "unsubscribe");
  confirmed(input.confirm);
  return withDomainMutation(owner, "subscriptions", async (tx) => {
    const previousGroups = await ownGroups(tx, owner, [id]);
    const memberships = await tx.select().from(feedGroups).where(eq(feedGroups.groupId, id));
    const members = await ownFeeds(tx, owner, memberships.map((row) => row.feedId));
    const removedIds = unsubscribe ? members.filter((feed) => !feed.isSpark).map((feed) => feed.id) : [];
    const feedSnapshot = await snapshotFeeds(tx, owner, removedIds, true);
    // Source unsubscribe deletes shared feeds too, while Spark subscriptions survive.
    if (removedIds.length) await tx.delete(feeds).where(and(eq(feeds.ownerId, owner.id), inArray(feeds.id, removedIds)));
    await tx.delete(groups).where(and(eq(groups.ownerId, owner.id), eq(groups.id, id)));
    await resetRemovedSelection(tx, owner, removedIds, [id]);
    const operationId = await journal(tx, owner, "group.delete", { ...feedSnapshot, groups: previousGroups, feedGroups: [...feedSnapshot.feedGroups, ...memberships.filter((membership) => !removedIds.includes(membership.feedId))] }, {}, [id, ...removedIds]);
    return { deleted: 1, feedsDeleted: removedIds.length, itemsDeleted: feedSnapshot.items?.length ?? 0, savedItemsDeleted: feedSnapshot.items?.filter((item) => item.isSaved).length ?? 0, operationId };
  });
}

export async function changeMembership(owner: OwnerContext, payload: unknown, add: boolean) {
  assertOwnerContext(owner);
  const input = object(payload);
  rejectUnknown(input, ["feedId", "groupId"]);
  const feedId = integer(input.feedId, "feedId", 1);
  const groupId = integer(input.groupId, "groupId", 1);
  return withDomainMutation(owner, "subscriptions", async (tx) => {
    await ownFeeds(tx, owner, [feedId]);
    await ownGroups(tx, owner, [groupId]);
    const condition = and(eq(feedGroups.feedId, feedId), eq(feedGroups.groupId, groupId));
    const before = await tx.select().from(feedGroups).where(condition);
    if (add) await tx.insert(feedGroups).values({ feedId, groupId }).onConflictDoNothing();
    else await tx.delete(feedGroups).where(condition);
    const after = await tx.select().from(feedGroups).where(condition);
    if (before.length === after.length) return { changed: 0, operationId: null };
    const operationId = await journal(tx, owner, add ? "membership.add" : "membership.remove", { feedGroups: before }, { feedGroups: after }, [feedId, groupId]);
    return { changed: 1, operationId };
  });
}

export async function updateSparks(owner: OwnerContext, payload: unknown) {
  assertOwnerContext(owner);
  const input = object(payload);
  rejectUnknown(input, ["feedIds"]);
  const selection = ids(input.feedIds, "feedIds");
  return withDomainMutation(owner, "subscriptions", async (tx) => {
    await ownFeeds(tx, owner, selection);
    const before = await tx.select().from(feeds).where(eq(feeds.ownerId, owner.id)).orderBy(feeds.id).for("update");
    const desired = new Set(selection);
    const changedIds = before.filter((row) => row.isSpark !== desired.has(row.id)).map((row) => row.id);
    if (!changedIds.length) return { changed: 0, operationId: null };
    await tx.update(feeds).set({ isSpark: false, updatedAt: new Date() }).where(and(eq(feeds.ownerId, owner.id), inArray(feeds.id, changedIds)));
    const promotedIds = selection.filter((id) => changedIds.includes(id));
    if (promotedIds.length) await tx.update(feeds).set({ isSpark: true }).where(and(eq(feeds.ownerId, owner.id), inArray(feeds.id, promotedIds)));
    const after = await tx.select().from(feeds).where(and(eq(feeds.ownerId, owner.id), inArray(feeds.id, changedIds)));
    const operationId = await journal(tx, owner, "sparks.update", { feeds: before.filter((row) => changedIds.includes(row.id)) }, { feeds: after }, changedIds);
    return { changed: changedIds.length, operationId };
  });
}

export async function deleteSparks(owner: OwnerContext, payload: unknown) {
  assertOwnerContext(owner);
  const input = object(payload);
  rejectUnknown(input, ["confirm"]);
  confirmed(input.confirm);
  return withDomainMutation(owner, "subscriptions", async (tx) => {
    const sparks = await tx.select({ id: feeds.id }).from(feeds).where(and(eq(feeds.ownerId, owner.id), eq(feeds.isSpark, true)));
    const selection = sparks.map((feed) => feed.id);
    const before = await snapshotFeeds(tx, owner, selection, true);
    if (selection.length) await tx.delete(feeds).where(and(eq(feeds.ownerId, owner.id), inArray(feeds.id, selection)));
    await resetRemovedSelection(tx, owner, selection);
    const operationId = selection.length ? await journal(tx, owner, "sparks.delete", before, {}, selection) : null;
    return { deleted: selection.length, itemsDeleted: before.items?.length ?? 0, savedItemsDeleted: before.items?.filter((item) => item.isSaved).length ?? 0, operationId };
  });
}

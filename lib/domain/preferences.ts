import "server-only";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Preferences, ReaderQuery, ViewState } from "../contracts";
import { getDb } from "../db/client";
import { owners, readerPreferences, readerViewState, sharingServices } from "../db/schema";
import { epochNow } from "../db/numbers";
import { DomainError, integer, object, text } from "../validation";
import { DEFAULT_PREFERENCES, DEFAULT_VIEW, preferencePatch, viewPatch } from "./options";
import { beginDomainMutation } from "./guard";
import { journal } from "./journal";
import type { DomainDb, OwnerContext } from "./types";

export function assertOwner(owner: OwnerContext) {
  integer(owner.id, "owner", 1);
  text(owner.email, "owner email", 320, false);
}

export async function getPreferences(owner: OwnerContext, db: DomainDb = getDb()): Promise<Preferences & { version: number }> {
  assertOwner(owner);
  const [stored] = await db.select({ preferences: readerPreferences }).from(readerPreferences).innerJoin(owners, eq(owners.id, readerPreferences.ownerId))
    .where(and(eq(readerPreferences.ownerId, owner.id), eq(owners.email, owner.email))).limit(1);
  const row = stored?.preferences;
  if (!row) throw new DomainError("Reader preferences have not been initialized.", "NOT_CONFIGURED", 409);
  const serviceRows = await db.select().from(sharingServices).where(eq(sharingServices.ownerId, owner.id)).orderBy(asc(sharingServices.position), asc(sharingServices.id));
  const preferences = { ...DEFAULT_PREFERENCES };
  for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
    if (key !== "services" && key in row) Object.assign(preferences, { [key]: row[key as keyof typeof row] });
  }
  preferences.services = serviceRows.map((service) => ({
    id: service.id, name: service.name, url: service.originalUrl, key: service.key,
    enabled: service.enabled, ...(service.reason ? { reason: service.reason } : {}),
  }));
  return { ...preferences, version: row.version };
}

export function deviceKey(value: unknown): string {
  const key = value === undefined ? "default" : text(value, "deviceKey", 128, false);
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new DomainError("Invalid reader device key.");
  return key;
}

export async function getViewState(owner: OwnerContext, key = "default", db: DomainDb = getDb()) {
  assertOwner(owner);
  const [row] = await db.select().from(readerViewState).where(and(eq(readerViewState.ownerId, owner.id), eq(readerViewState.deviceId, key))).limit(1);
  const view = { ...DEFAULT_VIEW };
  if (row) for (const name of Object.keys(DEFAULT_VIEW) as (keyof ViewState)[]) Object.assign(view, { [name]: row[name] });
  return { view, lastViewedAt: row?.lastViewedAt ?? 0, lastSessionAt: row?.lastSessionAt ?? 0 };
}

/** Called only by explicit reader visits. Reading-session time is separate from login expiry. */
export async function captureReaderView(owner: OwnerContext, query: ReaderQuery & { deviceKey?: string }, preferences: Preferences) {
  assertOwner(owner);
  const patch = viewPatch(query);
  const key = deviceKey(query.deviceKey);
  return getDb().transaction(async (tx) => {
    await beginDomainMutation(tx, owner);
    await tx.insert(readerViewState).values({ ownerId: owner.id, deviceId: key }).onConflictDoNothing();
    const [row] = await tx.select().from(readerViewState).where(and(eq(readerViewState.ownerId, owner.id), eq(readerViewState.deviceId, key))).for("update");
    const now = epochNow();
    const previous = row.section !== "search" && patch.section && patch.section !== row.section ? row.section : row.previous;
    const view = { ...DEFAULT_VIEW, ...Object.fromEntries(Object.keys(DEFAULT_VIEW).map((name) => [name, row[name as keyof typeof row]])), ...patch, previous: patch.previous ?? previous } as ViewState;
    if (view.section !== "kindling") view.groupId = 0;
    const lastSessionAt = row.lastViewedAt < now - preferences.sessionTimeout * 60 ? row.lastViewedAt : row.lastSessionAt;
    const [after] = await tx.update(readerViewState).set({ ...view, lastViewedAt: now, lastSessionAt, version: row.version + 1, updatedAt: new Date() }).where(and(eq(readerViewState.ownerId, owner.id), eq(readerViewState.deviceId, key))).returning();
    if (Object.keys(patch).some((name) => row[name as keyof typeof row] !== view[name as keyof ViewState])) {
      await journal(tx, owner, "view.save", { readerViewState: [row] }, { readerViewState: [after] });
    }
    return { view, lastSessionAt, renderedAt: now, deviceKey: key };
  });
}

export async function saveView(owner: OwnerContext, payload: unknown) {
  const input = object(payload);
  const preferences = await getPreferences(owner);
  const captured = await captureReaderView(owner, { ...viewPatch(input), deviceKey: deviceKey(input.deviceKey) }, preferences);
  return { view: captured.view, lastSessionAt: captured.lastSessionAt };
}

export async function resetRemovedSelection(db: DomainDb, owner: OwnerContext, removedFeedIds: number[], removedGroupIds: number[] = []) {
  // Update only matching selections; preserve unrelated device navigation and reading boundaries.
  if (!removedFeedIds.length && !removedGroupIds.length) return;
  const condition = and(eq(readerViewState.ownerId, owner.id), or(
    removedFeedIds.length ? inArray(readerViewState.feedId, removedFeedIds) : undefined,
    removedGroupIds.length ? inArray(readerViewState.groupId, removedGroupIds) : undefined,
  ));
  const before = await db.select().from(readerViewState).where(condition).for("update");
  if (removedFeedIds.length) await db.update(readerViewState).set({ feedId: 0 }).where(and(eq(readerViewState.ownerId, owner.id), inArray(readerViewState.feedId, removedFeedIds)));
  if (removedGroupIds.length) await db.update(readerViewState).set({ groupId: 0 }).where(and(eq(readerViewState.ownerId, owner.id), inArray(readerViewState.groupId, removedGroupIds)));
  if (before.length) {
    const after = await db.select().from(readerViewState).where(and(eq(readerViewState.ownerId, owner.id), inArray(readerViewState.deviceId, before.map((row) => row.deviceId))));
    await journal(db, owner, "view.selection-reset", { readerViewState: before }, { readerViewState: after });
  }
}

export async function savePreferences(owner: OwnerContext, payload: unknown) {
  assertOwner(owner);
  const input = object(payload);
  const patch = preferencePatch(input);
  return getDb().transaction(async (tx) => {
    await beginDomainMutation(tx, owner);
    const [row] = await tx.select().from(readerPreferences).where(eq(readerPreferences.ownerId, owner.id)).for("update");
    if (!row) throw new DomainError("Reader preferences have not been initialized.", "NOT_CONFIGURED", 409);
    if (input.version !== undefined && integer(input.version, "version", 1) !== row.version) throw new DomainError("Preferences changed in another request. Reload them before saving.", "CONFLICT", 409);
    if (patch.blacklist !== undefined && patch.blacklist !== row.blacklist) throw new DomainError("Save blacklist changes through the blacklist editor so existing Hot links are recomputed.", "BLACKLIST_REQUIRES_RECOMPUTE", 409);
    const { services, blacklist: _blacklist, ...settings } = patch;
    void _blacklist;
    const previousServices = await tx.select().from(sharingServices).where(eq(sharingServices.ownerId, owner.id)).orderBy(sharingServices.position);
    const [afterPreferences] = await tx.update(readerPreferences).set({ ...settings, version: row.version + 1, updatedAt: new Date() }).where(eq(readerPreferences.ownerId, owner.id)).returning();
    if (services) {
      const knownIds = new Set(previousServices.map((service) => service.id));
      const suppliedIds = services.flatMap((service) => service.id === undefined ? [] : [service.id]);
      if (new Set(suppliedIds).size !== suppliedIds.length || suppliedIds.some((id) => !knownIds.has(id))) throw new DomainError("A sharing service no longer exists. Reload preferences before saving.", "CONFLICT", 409);
      await tx.delete(sharingServices).where(eq(sharingServices.ownerId, owner.id));
      if (services.length) await tx.insert(sharingServices).values(services.map((service, position) => ({
        ...(service.id === undefined ? {} : { id: service.id }),
        ownerId: owner.id, position, name: service.name, originalUrl: service.url, url: service.url.replace(/^#/, ""),
        key: service.key, enabled: service.enabled !== false, reason: service.reason ?? null,
        transport: service.enabled === false ? "disabled" : service.url.startsWith("#") ? "background" : "navigate",
      })));
    }
    const afterServices = await tx.select().from(sharingServices).where(eq(sharingServices.ownerId, owner.id)).orderBy(sharingServices.position);
    const operationId = await journal(tx, owner, "preferences.save", { readerPreferences: [row], sharingServices: previousServices }, { readerPreferences: [afterPreferences], sharingServices: afterServices });
    return { preferences: await getPreferences(owner, tx), version: row.version + 1, operationId };
  });
}

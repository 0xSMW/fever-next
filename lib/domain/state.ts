import "server-only";
import { and, eq, gt, inArray, lt, max, sql, type SQL } from "drizzle-orm";
import type { Section } from "../contracts";
import { feedGroups, feeds, groups, items, stateOperations } from "../db/schema";
import { epochNow } from "../db/numbers";
import { DomainError, boolean, ids, integer, object } from "../validation";
import { journal } from "./journal";
import { assertOwnerContext, withDomainMutation } from "./transaction";
import type { DomainDb, MutationOrigin, OwnerContext, ScopeReadInput } from "./types";

type StateAction = "read" | "unread" | "save" | "unsave";
type StateRow = Pick<typeof items.$inferSelect, "id" | "readAt" | "isSaved" | "stateVersion">;
const stateColumns = { id: items.id, readAt: items.readAt, isSaved: items.isSaved, stateVersion: items.stateVersion };
const reversibleActions = new Set(["items.read", "items.unread", "items.save", "items.unsave", "scope.read", "items.undo-recent", "items.undo-operation"]);

function recordedStates(value: unknown): StateRow[] {
  if (!Array.isArray(value)) throw new DomainError("This operation has no reversible reading-state snapshot.", "INVALID_OPERATION", 409);
  return value.map((entry) => {
    const row = object(entry, "recorded state");
    return { id: integer(row.id, "id", 1), readAt: integer(row.readAt, "readAt"), isSaved: boolean(row.isSaved, "isSaved"), stateVersion: integer(row.stateVersion, "stateVersion") };
  });
}

async function applyStates(db: DomainDb, owner: OwnerContext, action: StateAction, predicate: SQL, origin: MutationOrigin, expectedIds?: number[], journalAction = `items.${action}`) {
  const before = await db.select(stateColumns).from(items).innerJoin(feeds, eq(items.feedId, feeds.id))
    .where(and(eq(feeds.ownerId, owner.id), predicate)).orderBy(items.id).for("update", { of: items });
  if (expectedIds && before.length !== expectedIds.length) throw new DomainError("One or more items no longer exist.", "NOT_FOUND", 404);
  const now = epochNow();
  const changed = before.filter((row) => action === "read" ? row.readAt === 0 : action === "unread" ? row.readAt !== 0 : action === "save" ? !row.isSaved || (origin === "ui" && row.readAt === 0) : row.isSaved);
  if (!changed.length) return { changed: 0, operationId: null };
  // Read timestamps are stable under repeated read/save requests.
  const readAt = sql`CASE WHEN ${items.readAt} = 0 THEN ${now} ELSE ${items.readAt} END`;
  const values = {
    stateVersion: sql`${items.stateVersion} + 1`,
    ...(action === "read" || (action === "save" && origin === "ui") ? { readAt } : {}),
    ...(action === "unread" ? { readAt: 0 } : {}),
    ...(action === "save" || action === "unsave" ? { isSaved: action === "save" } : {}),
  };
  const after = await db.update(items).set(values).where(inArray(items.id, changed.map((row) => row.id))).returning(stateColumns);
  const operationId = await journal(db, owner, journalAction, { items: changed }, { items: after }, changed.map((row) => row.id), origin);
  return { changed: after.length, operationId };
}

export async function mutateItems(owner: OwnerContext, action: StateAction, itemIds: number[], options: { origin?: MutationOrigin; section?: Section } = {}) {
  assertOwnerContext(owner);
  const selection = ids(itemIds);
  if (!selection.length) return { changed: 0, operationId: null };
  return withDomainMutation(owner, "reading-state", async (tx) => {
    return applyStates(tx, owner, action, inArray(items.id, selection), options.origin ?? "ui", selection);
  });
}

export async function markScopeRead(owner: OwnerContext, input: ScopeReadInput, origin: MutationOrigin = "ui") {
  assertOwnerContext(owner);
  const before = integer(input.before, "before", 0);
  return withDomainMutation(owner, "reading-state", async (tx) => {
    let scope: SQL = sql`true`;
    if (input.scope === "feed") {
      const id = integer(input.id, "id", 1);
      const [feed] = await tx.select({ id: feeds.id }).from(feeds).where(and(eq(feeds.ownerId, owner.id), eq(feeds.id, id)));
      if (!feed) throw new DomainError("Feed not found.", "NOT_FOUND", 404);
      scope = eq(items.feedId, id);
    } else if (input.scope === "group") {
      const id = integer(input.id, "id", 1);
      const [group] = await tx.select({ id: groups.id }).from(groups).where(and(eq(groups.ownerId, owner.id), eq(groups.id, id)));
      if (!group) throw new DomainError("Group not found.", "NOT_FOUND", 404);
      scope = inArray(items.feedId, tx.select({ id: feedGroups.feedId }).from(feedGroups).where(eq(feedGroups.groupId, id)));
    } else if (input.scope === "sparks") scope = eq(feeds.isSpark, true);
    else if (input.scope !== "all") throw new DomainError("Invalid read scope.");
    // Both all and custom-group retain source inclusion of Spark rows. The cutoff is strict.
    return applyStates(tx, owner, "read", and(scope, eq(items.readAt, 0), lt(items.addedAt, before))!, origin, undefined, "scope.read");
  });
}

/** Source-compatible recent-read action, including its cross-Spark 15-second update window. */
export async function undoRecentlyRead(owner: OwnerContext, section: Section, origin: MutationOrigin = "ui") {
  assertOwnerContext(owner);
  return withDomainMutation(owner, "reading-state", async (tx) => {
    const [latest] = await tx.select({ readAt: max(items.readAt) }).from(items).innerJoin(feeds, eq(items.feedId, feeds.id))
      .where(and(eq(feeds.ownerId, owner.id), section === "sparks" ? undefined : eq(feeds.isSpark, false)));
    if (!latest?.readAt) return { changed: 0, operationId: null };
    return applyStates(tx, owner, "unread", and(gt(items.readAt, latest.readAt - 15), gt(items.readAt, 0))!, origin, undefined, "items.undo-recent");
  });
}

/** Exact journal undo is separate from the legacy command and refuses to overwrite a later mutation. */
export async function undoOperation(owner: OwnerContext, operationId: number, origin: MutationOrigin = "ui") {
  assertOwnerContext(owner);
  integer(operationId, "operationId", 1);
  return withDomainMutation(owner, "reading-state", async (tx) => {
    const [operation] = await tx.select().from(stateOperations).where(and(eq(stateOperations.ownerId, owner.id), eq(stateOperations.id, operationId))).for("update");
    if (!operation) throw new DomainError("Reading operation not found.", "NOT_FOUND", 404);
    if (operation.undoneAt) return { changed: 0, operationId: null };
    if (!reversibleActions.has(operation.action)) throw new DomainError("This operation does not support reading-state undo.", "INVALID_OPERATION", 409);
    const previous = recordedStates(operation.before.items);
    const expected = recordedStates(operation.after.items);
    const selection = ids(expected.map((row) => row.id));
    const previousIds = new Set(previous.map((row) => row.id));
    if (selection.length !== expected.length || previous.length !== expected.length || previousIds.size !== selection.length || selection.some((id) => !previousIds.has(id))) {
      throw new DomainError("The recorded undo snapshot is inconsistent.", "INVALID_OPERATION", 409);
    }
    if (!selection.length) return { changed: 0, operationId: null };
    const current = await tx.select(stateColumns).from(items).innerJoin(feeds, eq(items.feedId, feeds.id)).where(and(eq(feeds.ownerId, owner.id), inArray(items.id, selection))).orderBy(items.id).for("update", { of: items });
    const expectedById = new Map(expected.map((row) => [row.id, row]));
    if (current.length !== expected.length || current.some((row) => {
      const after = expectedById.get(row.id)!;
      return row.stateVersion !== after.stateVersion || row.readAt !== after.readAt || row.isSaved !== after.isSaved;
    })) throw new DomainError("An affected item changed after this operation. Reload before choosing another action.", "UNDO_CONFLICT", 409);
    const after: StateRow[] = [];
    for (const row of previous) {
      const [restored] = await tx.update(items).set({ readAt: row.readAt, isSaved: row.isSaved, stateVersion: sql`${items.stateVersion} + 1` }).where(eq(items.id, row.id)).returning(stateColumns);
      after.push(restored);
    }
    await tx.update(stateOperations).set({ undoneAt: new Date(), version: operation.version + 1 }).where(eq(stateOperations.id, operation.id));
    const undoId = await journal(tx, owner, "items.undo-operation", { items: current }, { items: after, undoneOperationId: operationId }, selection, origin);
    return { changed: after.length, operationId: undoId };
  });
}

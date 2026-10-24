import "server-only";
import { stateOperations, type JsonObject } from "../db/schema";
import type { DomainDb, MutationOrigin, OwnerContext } from "./types";

/** Table-keyed snapshots are intentionally replayable; no plaintext credentials enter this journal. */
export async function journal(db: DomainDb, owner: OwnerContext, action: string, before: JsonObject, after: JsonObject, affectedIds: number[] = [], origin: MutationOrigin = "ui") {
  const [operation] = await db.insert(stateOperations).values({ ownerId: owner.id, action, origin, affectedIds, before, after }).returning({ id: stateOperations.id });
  return operation.id;
}

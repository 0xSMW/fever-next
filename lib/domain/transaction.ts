import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { integer, text } from "../validation";
import { beginDomainMutation } from "./guard";
import type { DomainDb, OwnerContext } from "./types";

/** Shape validation only. Authorization remains inside the transaction guard. */
export function assertOwnerContext(owner: OwnerContext): void {
  integer(owner.id, "owner", 1);
  text(owner.email, "owner email", 320, false);
}
export function withDomainMutation<T>(owner: OwnerContext, lock: "subscriptions" | "reading-state" | undefined, work: (tx: DomainDb) => Promise<T>): Promise<T> {
  assertOwnerContext(owner);
  return getDb().transaction(async tx => {
    await beginDomainMutation(tx, owner);
    if (lock) await tx.execute(sql`SELECT pg_advisory_xact_lock(${owner.id}, ${lock === "subscriptions" ? 9183 : 9184})`);
    return work(tx);
  });
}
export function withReaderSnapshot<T>(owner: OwnerContext, work: (tx: DomainDb) => Promise<T>): Promise<T> {
  assertOwnerContext(owner);
  return getDb().transaction(async tx => {
    await beginDomainMutation(tx, owner, { readOnly: true });
    return work(tx);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getCheckedSessionEpoch } from "../auth/owner";
import { installation, owners } from "../db/schema";
import { DomainError } from "../validation";
import type { DomainDb, OwnerContext } from "./types";

/** Shares maintenance's installation lock and holds authorization through domain commit. */
export async function beginDomainMutation(db: DomainDb, owner: OwnerContext, options: { readOnly?: boolean } = {}) {
  await db.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('fever:installation', 0))`);
  const [state] = await db.select({ status: installation.status }).from(installation).where(eq(installation.id, 1));
  if (state?.status !== "ready") throw new DomainError("The reader is unavailable during installation or maintenance.", "MAINTENANCE", 503);
  const epoch = getCheckedSessionEpoch(owner);
  // Auth rotations take the same installation lock before updating this row.
  // SHARE makes rotation wait for this mutation, or rechecks a completed rotation.
  const query = db.select({ id: owners.id }).from(owners)
    .where(and(eq(owners.id, owner.id), eq(owners.email, owner.email), eq(owners.recoveryRequired, false),
      epoch === undefined ? undefined : eq(owners.authEpoch, epoch)));
  const [account] = await (options.readOnly ? query : query.for("share"));
  if (!account) throw new DomainError("Authentication is required.", "UNAUTHORIZED", 401);
}

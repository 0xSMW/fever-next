import "server-only";
import type { OwnerContext } from "../auth";
import type { DomainCommandResult, RefreshAfterChangeResult, SubscriptionAction } from "../command-contract";
import { executeDomainCommand } from "../domain/commands";
import { refreshAfterChange } from "./refresh";

/** Commit first; scheduling cannot turn a committed subscription into a failed change. */
export async function changeSubscription<A extends SubscriptionAction>(owner: OwnerContext, action: A, payload: unknown): Promise<DomainCommandResult<A> & RefreshAfterChangeResult> {
  const result = await executeDomainCommand(owner, action, payload) as DomainCommandResult<A>;
  const refresh = await refreshAfterChange(owner, { scope: "feed", id: result.id, force: action === "feed.authenticate" });
  return { ...result, ...refresh };
}

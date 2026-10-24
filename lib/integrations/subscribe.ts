import "server-only";
import type { OwnerContext } from "@/lib/auth";
import { executeDomainCommand } from "@/lib/domain/commands";
import { getSubscriptionCatalog } from "@/lib/domain/catalog";
import { parseFeedInput } from "@/lib/domain/input";
import { refreshAfterChange } from "./refresh";
import { HttpError, record } from "./http";
export async function subscribe(owner: OwnerContext, input: unknown) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw new HttpError("Select between one and 100 feeds.");
  const selected = input.map(value => parseFeedInput(record(value)));
  const groups = new Set((await getSubscriptionCatalog(owner)).groups.map(group => group.id));
  for (const feed of selected) {
    if (feed.groupIds?.some(id => !groups.has(id))) throw new HttpError("A selected group no longer exists.", 404, "GROUP_NOT_FOUND");
    if (feed.username?.includes(":")) throw new HttpError("A Basic authentication username cannot contain a colon.");
  }
  const ids: number[] = [], warnings: string[] = [];
  let added = 0;
  for (const value of selected) {
    const result = await executeDomainCommand(owner, "feed.create", value);
    const id = result.id;
    if (!ids.includes(id)) ids.push(id);
    if (result.created) added++;
    else warnings.push("An existing subscription was retained.");
    const refresh = await refreshAfterChange(owner, { scope: "feed", id });
    warnings.push(...refresh.warnings.map(warning => `${value.url}: ${warning}`));
  }
  return { added, ids, warnings };
}

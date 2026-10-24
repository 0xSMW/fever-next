import "server-only";
import type { OwnerContext } from "@/lib/auth";
import { executeDomainCommand, getNavigation } from "@/lib/domain";
import { parseFeedInput } from "@/lib/domain/input";
import { enqueueRefresh } from "@/lib/jobs";
import { HttpError, record } from "./http";
export async function subscribe(owner: OwnerContext, input: unknown) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw new HttpError("Select between one and 100 feeds.");
  const selected = input.map(value => parseFeedInput(record(value)));
  const groups = new Set((await getNavigation(owner)).groups.map(group => group.id));
  for (const feed of selected) {
    if (feed.groupIds?.some(id => !groups.has(id))) throw new HttpError("A selected group no longer exists.", 404, "GROUP_NOT_FOUND");
    if (feed.username?.includes(":")) throw new HttpError("A Basic authentication username cannot contain a colon.");
  }
  const ids: number[] = [], warnings: string[] = [];
  let added = 0;
  for (const value of selected) {
    const result = await executeDomainCommand(owner, "feed.create", value);
    const id = Number(result.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Feed creation did not return an identity.");
    if (!ids.includes(id)) ids.push(id);
    if (result.created) added++;
    else warnings.push("An existing subscription was retained.");
    try { await enqueueRefresh(owner, { scope: "feed", id }); }
    catch { warnings.push("A subscription was saved, but its refresh could not be queued. Refresh it from the reader."); }
  }
  return { added, ids, warnings };
}

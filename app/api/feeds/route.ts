import { requireMutation, requireOwner } from "@/lib/auth";
import { executeDomainCommand, getNavigation } from "@/lib/domain";
import { endpoint, integer, json, readJson } from "@/lib/integrations/http";
import { refreshAfterChange } from "@/lib/integrations/refresh";
export const dynamic = "force-dynamic";
export const GET = () => endpoint(async () => json((await getNavigation(await requireOwner())).feeds));
export const POST = (request: Request) => endpoint(async () => {
  const owner = await requireMutation(request);
  const result = await executeDomainCommand(owner, "feed.create", await readJson(request));
  const refresh = await refreshAfterChange(owner, { scope: "feed", id: integer(result.id, "id", 1) });
  return json({ ok: true, ...result, ...refresh }, result.created ? 201 : 200);
});

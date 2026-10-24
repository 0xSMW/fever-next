import { requireMutation, requireOwner } from "@/lib/auth";
import { getNavigation } from "@/lib/domain";
import { endpoint, json, readJson } from "@/lib/integrations/http";
import { changeSubscription } from "@/lib/integrations/subscriptions";
export const dynamic = "force-dynamic";
export const GET = () => endpoint(async () => json((await getNavigation(await requireOwner())).feeds));
export const POST = (request: Request) => endpoint(async () => {
  const owner = await requireMutation(request);
  const result = await changeSubscription(owner, "feed.create", await readJson(request));
  return json({ ok: true, ...result }, result.created ? 201 : 200);
});

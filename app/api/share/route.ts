import { requireMutation } from "@/lib/auth";
import { endpoint, integer, json, readJson } from "@/lib/integrations/http";
import { shareItem } from "@/lib/integrations/sharing";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => endpoint(async () => {
  const owner = await requireMutation(request), payload = await readJson(request, 4096);
  return json({ ok: true, ...await shareItem(owner, integer(payload.serviceId, "serviceId", 1), integer(payload.itemId, "itemId", 1)) });
});

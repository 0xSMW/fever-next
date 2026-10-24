import { requireMutation } from "@/lib/auth";
import { subscribe } from "@/lib/integrations/subscribe";
import { endpoint, json, readJson } from "@/lib/integrations/http";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => endpoint(async () => { const owner = await requireMutation(request); return json(await subscribe(owner, (await readJson(request)).feeds)); });

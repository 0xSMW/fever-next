import { requireOwner } from "@/lib/auth";
import { getItem } from "@/lib/domain";
import { endpoint, HttpError, integer, json } from "@/lib/integrations/http";
export const dynamic = "force-dynamic";
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) => endpoint(async () => {
  const deviceKey = new URL(request.url).searchParams.get("deviceKey");
  if (deviceKey !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(deviceKey)) throw new HttpError("Invalid reader device key.");
  return json(await getItem(await requireOwner(), integer((await context.params).id, "id", 1), deviceKey === null ? {} : { deviceKey }));
});

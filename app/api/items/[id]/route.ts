import { requireOwner } from "@/lib/auth";
import { getItem } from "@/lib/domain";
import { endpoint, HttpError, integer, json } from "@/lib/integrations/http";
import { isDeviceKey } from "@/lib/reader-policy";
export const dynamic = "force-dynamic";
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) => endpoint(async () => {
  const deviceKey = new URL(request.url).searchParams.get("deviceKey");
  if (deviceKey !== null && !isDeviceKey(deviceKey)) throw new HttpError("Invalid reader device key.");
  return json(await getItem(await requireOwner(), integer((await context.params).id, "id", 1), deviceKey === null ? {} : { deviceKey }));
});

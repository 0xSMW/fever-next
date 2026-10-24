import { requireOwner } from "@/lib/auth";
import { endpoint, HttpError, integer } from "@/lib/integrations/http";
import { mediaResponse } from "@/lib/integrations/media";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = (request: Request) => endpoint(async () => {
  const params = new URL(request.url).searchParams;
  const url = params.get("url");
  if (!url) throw new HttpError("An image URL is required.");
  return mediaResponse(await requireOwner(), integer(params.get("itemId"), "itemId", 1), url);
});

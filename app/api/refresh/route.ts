import { requireOwner } from "@/lib/auth";
import { getRefreshJob } from "@/lib/jobs";
import { endpoint, integer, json } from "@/lib/integrations/http";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => endpoint(async () => {
  const id = new URL(request.url).searchParams.get("id");
  return json(await getRefreshJob(await requireOwner(), id === null ? undefined : integer(id, "id", 1)));
});

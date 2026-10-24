import { requireOwner } from "@/lib/auth";
import { bool, csvIds, endpoint, privateHeaders } from "@/lib/integrations/http";
import { exportOpml } from "@/lib/integrations/opml";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => endpoint(async () => {
  const params = new URL(request.url).searchParams;
  const result = await exportOpml(await requireOwner(), { groupIds: csvIds(params.get("groupIds"), "groupIds", true), flatten: bool(params.get("flatten"), "flatten") ?? false, includeSparks: bool(params.get("includeSparks"), "includeSparks") ?? false });
  return new Response(result.xml, { headers: { ...privateHeaders, "Content-Type": "text/x-opml; charset=utf-8", "Content-Disposition": `attachment; filename="${result.filename}"` } });
});

import { requireOwner } from "@/lib/auth";
import { getReaderView } from "@/lib/domain";
import { bool, endpoint, json } from "@/lib/integrations/http";
import { readerQuery } from "@/lib/integrations/reader-query";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => endpoint(async () => {
  const params = new URL(request.url).searchParams;
  const capture = bool(params.get("capture"), "capture") ?? true;
  params.delete("capture");
  return json(await getReaderView(await requireOwner(), readerQuery(params), { capture }));
});

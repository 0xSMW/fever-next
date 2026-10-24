import { requireMutation } from "@/lib/auth";
import { endpoint, HttpError, json, readJson } from "@/lib/integrations/http";
import { importOpml, parseOpml } from "@/lib/integrations/opml";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => endpoint(async () => {
  const owner = await requireMutation(request);
  const body = await readJson(request, 6_291_456);
  if (typeof body.xml !== "string" || typeof body.importGroups !== "boolean") throw new HttpError("Provide OPML XML and the import-groups choice.");
  if (body.preview !== undefined && typeof body.preview !== "boolean") throw new HttpError("preview must be a boolean.");
  if (body.preview === true) return json(parseOpml(body.xml, body.importGroups));
  return json(await importOpml(owner, body.xml, body.importGroups));
});

import { requireOwner } from "@/lib/auth";
import { endpoint, integer } from "@/lib/integrations/http";
import { faviconResponse } from "@/lib/integrations/media";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = (_request: Request, context: { params: Promise<{ id: string }> }) => endpoint(async () => faviconResponse(await requireOwner(), integer((await context.params).id, "id", 0) || 1));

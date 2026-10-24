import { requireOwner } from "@/lib/auth";
import { diagnostics } from "@/lib/observability/diagnostics";
import { endpoint, json } from "@/lib/integrations/http";
export const dynamic = "force-dynamic";
export const GET = () => endpoint(async () => json(await diagnostics(await requireOwner())));

import { rootCompatibility } from "@/lib/compat/root";
import { endpoint } from "@/lib/integrations/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = (request: Request) => endpoint(() => rootCompatibility(request));
export const POST = (request: Request) => endpoint(() => rootCompatibility(request));

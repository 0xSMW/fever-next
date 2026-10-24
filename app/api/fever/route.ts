import { handleFever } from "@/lib/compat/fever";
import { endpoint } from "@/lib/integrations/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = (request: Request) => endpoint(() => handleFever(request));
export const POST = (request: Request) => endpoint(() => handleFever(request));

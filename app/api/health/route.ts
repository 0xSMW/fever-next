import { readiness } from "@/lib/observability/diagnostics";
export const dynamic = "force-dynamic";
export const GET = async () => { const ready = await readiness(); return Response.json({ status: ready ? "ready" : "unavailable" }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); };

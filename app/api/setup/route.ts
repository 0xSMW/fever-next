import { getAuthenticatedOwner } from "@/lib/auth/owner";
import { authErrorResponse } from "@/lib/auth/errors";
import { assertCsrf, readJsonBody } from "@/lib/auth/security";
import { initializeInstallation } from "@/lib/auth/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertCsrf(request, await getAuthenticatedOwner(request));
    const result = await initializeInstallation(await readJsonBody(request));
    return Response.json(result, { status: 201, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return authErrorResponse(error); }
}

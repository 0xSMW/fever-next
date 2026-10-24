import { getAuthenticatedOwner } from "@/lib/auth/owner";
import { authErrorResponse } from "@/lib/auth/errors";
import { recoverPassword } from "@/lib/auth/recovery";
import { assertCsrf, readJsonBody } from "@/lib/auth/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertCsrf(request, await getAuthenticatedOwner(request));
    const result = await recoverPassword(await readJsonBody(request));
    return Response.json(result, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) { return authErrorResponse(error); }
}

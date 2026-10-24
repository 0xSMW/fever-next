import type { SessionDTO } from "@/lib/contracts";
import { getAuthenticatedOwner, requireMutation } from "@/lib/auth/owner";
import { revokeSessions } from "@/lib/auth/account";
import { authErrorResponse, invalidInput } from "@/lib/auth/errors";
import { issueCsrfToken, readJsonBody, validateKeys } from "@/lib/auth/security";
import { isInstallationConfigured } from "@/lib/auth/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const responseHeaders = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie", "Referrer-Policy": "same-origin" };

export async function GET(request: Request) {
  try {
    const owner = await getAuthenticatedOwner(request);
    const { token, cookie } = issueCsrfToken(request, owner);
    const result: SessionDTO = {
      configured: await isInstallationConfigured(), authenticated: !!owner, csrfToken: token,
      ...(owner ? { owner: { id: owner.id, email: owner.email } } : {}),
    };
    return Response.json(result, { headers: { ...responseHeaders, "Set-Cookie": cookie } });
  } catch (error) { return authErrorResponse(error); }
}

/** Explicit logout-all; ordinary device logout uses next-auth/react signOut. */
export async function POST(request: Request) {
  try {
    const owner = await requireMutation(request);
    const payload = await readJsonBody(request);
    validateKeys(payload, ["action"]);
    if (payload.action !== "logoutAll") invalidInput("Unsupported session action.");
    await revokeSessions(owner);
    return Response.json({ ok: true, reauthenticate: true }, { headers: responseHeaders });
  } catch (error) { return authErrorResponse(error); }
}

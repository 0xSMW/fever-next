import NextAuth from "next-auth";
import { NextRequest } from "next/server";
import { getAuthOptions } from "@/lib/auth/options";
import { authErrorResponse } from "@/lib/auth/errors";
import { assertRequestPath, assertSameOrigin, readBoundedBody } from "@/lib/auth/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ nextauth: string[] }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    assertRequestPath(request);
    const response = await NextAuth(getAuthOptions())(request, { params: await context.params });
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) { return authErrorResponse(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    assertSameOrigin(request);
    const body = await readBoundedBody(request, 16_384);
    const boundedRequest = new NextRequest(request.url, { method: "POST", headers: request.headers, body });
    const response = await NextAuth(getAuthOptions())(boundedRequest, { params: await context.params });
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) { return authErrorResponse(error); }
}

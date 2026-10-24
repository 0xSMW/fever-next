import { NextResponse, type NextRequest } from "next/server";
import { ROOT_QUERY_HEADER } from "./lib/http/root-compat";

const legacyActions = ["subscribe", "feedlet", "shortcuts", "extras", "blacklist", "visit", "refresh", "favicons", "img", "empty-cache", "manage", "empty", "flush", "unorphan", "uninstall", "updates", "update", "updated", "revert", "manifest", "logout"];

/** Legacy clients send bare flags (?api), which Next's truthy `has` matcher skips. */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  // Only a root rewrite may supply this internal transport value.
  headers.delete(ROOT_QUERY_HEADER);
  if (request.nextUrl.pathname !== "/") return NextResponse.next({ request: { headers } });
  const query = request.nextUrl.searchParams;
  const path = query.has("api") ? "/api/compat"
    : query.get("rss") === "saved" ? "/rss/saved"
    : legacyActions.some((key) => query.has(key)) ? "/api/compat" : null;
  if (!path) return NextResponse.next();
  const destination = request.nextUrl.clone();
  // NextURL retains the configured basePath independently of pathname.
  destination.pathname = path;
  // CDN route normalization can strip query keys repeated in a rewrite target.
  // Preserve the original query independently, including empty values and order.
  if (path === "/api/compat") headers.set(ROOT_QUERY_HEADER, request.nextUrl.search);
  return NextResponse.rewrite(destination, { request: { headers } });
}

export const config = { matcher: ["/", "/api/compat"] };

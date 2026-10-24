import { NextRequest } from "next/server";

export const ROOT_QUERY_HEADER = "x-fever-root-query";

/** Restore only the query carried by the root proxy, never its origin or path. */
export function rootCompatibilityRequest(request: Request): Request {
  const search = request.headers.get(ROOT_QUERY_HEADER);
  if (search === null) return request;
  const url = new URL(request.url);
  url.search = search;
  // Keep NextRequest identity for Next's normalized base-path auth validation.
  const restored = request instanceof NextRequest ? new NextRequest(url, request) : new Request(url, request);
  restored.headers.delete(ROOT_QUERY_HEADER);
  return restored;
}

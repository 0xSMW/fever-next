import "server-only";
import { and, eq } from "drizzle-orm";
import { getOwner, requireOwner } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { favicons, feeds } from "@/lib/db/schema";
import { HttpError, integer, privateHeaders } from "@/lib/integrations/http";
import { mediaResponse } from "@/lib/integrations/media";
import { savedRss } from "@/lib/integrations/rss";
import { rootCompatibilityRequest } from "@/lib/http/root-compat";
import { handleFever } from "./fever";

function baseUrl(): URL {
  const base = getConfig().baseUrl;
  if (!base) throw new Error("The canonical installation URL is not configured.");
  return new URL(base.endsWith("/") ? base : `${base}/`);
}
function redirect(path: string, params?: URLSearchParams): Response {
  const url = new URL(path.replace(/^\//, ""), baseUrl());
  if (params) url.search = params.toString();
  return new Response(null, { status: 303, headers: { ...privateHeaders, Location: url.href } });
}
function rebuilt(value: string, protocol: string | null): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (protocol && /^https?:?$/.test(protocol)) return `${protocol.replace(/:$/, "")}://${value.replace(/^\/\//, "")}`;
  return value;
}
/** Static bookmarklet loader; it navigates to the authenticated confirmation page. */
function bookmarklet(): Response {
  const destination = new URL("feedlet", baseUrl()).href;
  const script = `(()=>{const target=new URL(${JSON.stringify(destination)});target.searchParams.set("url",location.href);target.searchParams.set("title",document.title);let count=0;for(const node of document.querySelectorAll('link[rel~="alternate"]')){if(count>=100)break;if(!["application/rss+xml","application/atom+xml"].includes(node.type.toLowerCase()))continue;try{const url=new URL(node.href,location.href);if(!/^https?:$/.test(url.protocol))continue;target.searchParams.set("feeds["+count+"][href]",url.href);target.searchParams.set("feeds["+count+"][title]",node.title||document.title);target.searchParams.set("feeds["+count+"][type]","link");count++;}catch{}}location.assign(target.href);})();`;
  return new Response(script, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}
export async function rootCompatibility(request: Request): Promise<Response> {
  request = rootCompatibilityRequest(request);
  const query = new URL(request.url).searchParams;
  if (query.has("api")) return handleFever(request);
  if (query.get("rss") === "saved" && request.method === "GET") return savedRss();
  if (request.method !== "GET") throw new HttpError("Open the current Fever interface to confirm this action with its protected form.", 409, "LEGACY_FORM_REQUIRES_CONFIRMATION");
  if (query.has("feedlet") && query.has("js")) return bookmarklet();
  const page = query.has("feedlet") ? "feedlet" : query.has("subscribe") ? "subscribe" : null;
  if (page) {
    const params = new URLSearchParams();
    if (query.has("url")) params.set("url", rebuilt(query.get("url")!, query.get("protocol")));
    if (query.has("title")) params.set("title", query.get("title")!.slice(0, 4096));
    if (query.has("candidates")) params.set("candidates", query.get("candidates")!.slice(0, 65536));
    const embedded = new Map<string, Record<string, string>>();
    for (const [name, value] of query) {
      const match = /^feeds\[(\d{1,3})\]\[(href|url|protocol|title|type)\]$/.exec(name);
      if (!match || Number(match[1]) > 99 || value.length > 8192) continue;
      const feed = embedded.get(match[1]) ?? {}; feed[match[2]] = value; embedded.set(match[1], feed);
    }
    if (embedded.size) {
      let index = 0;
      for (const feed of embedded.values()) {
        params.set(`feeds[${index}][href]`, rebuilt(feed.href || feed.url || "", feed.protocol ?? null));
        params.set(`feeds[${index}][title]`, feed.title || "Feed");
        params.set(`feeds[${index}][type]`, feed.type === "a" ? "a" : "link");
        index++;
      }
    }
    return redirect(page, params);
  }
  if (query.has("manifest")) {
    // Legacy application-cache manifests must never retain authenticated reader responses.
    return new Response("CACHE MANIFEST\n# Retired. Reload Fever online.\nNETWORK:\n*\n", { status: 410, headers: { "Content-Type": "text/cache-manifest; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (!await getOwner(request)) {
    const returnUrl = new URL(request.url);
    const params = new URLSearchParams({ return: `/?${returnUrl.searchParams}` });
    return redirect("login", params);
  }
  const owner = await requireOwner(request);
  if (query.has("visit")) {
    const id = integer(query.get("visit"), "visit", 1);
    const [feed] = await getDb().select({ siteUrl: feeds.siteUrl, url: feeds.url }).from(feeds).where(and(eq(feeds.id, id), eq(feeds.ownerId, owner.id))).limit(1);
    if (!feed) throw new HttpError("This feed no longer exists.", 404, "FEED_NOT_FOUND");
    let destination: URL;
    try { destination = new URL(feed.siteUrl || feed.url); } catch { throw new HttpError("This feed has no valid website URL."); }
    if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password) throw new HttpError("This feed has no permitted website URL.");
    return new Response(null, { status: 303, headers: { ...privateHeaders, Location: destination.href, "Referrer-Policy": "no-referrer" } });
  }
  if (query.has("img")) return mediaResponse(owner, integer(query.get("itemId"), "itemId", 1), query.get("img")!);
  if (query.has("favicons")) {
    const icons = await getDb().select({ id: favicons.id }).from(favicons).where(eq(favicons.ownerId, owner.id));
    const css = icons.map(icon => `i.f${icon.id} i{background-image:url("${new URL(`api/favicons/${icon.id}`, baseUrl()).href}")}`).join("\n");
    return new Response(css, { headers: { ...privateHeaders, "Content-Type": "text/css; charset=utf-8" } });
  }
  for (const name of ["empty", "flush", "unorphan", "uninstall"] as const) if (query.has(name)) return redirect("maintenance", new URLSearchParams({ operation: name }));
  if (query.has("empty-cache")) return redirect("maintenance", new URLSearchParams({ operation: "favicons" }));
  if (query.has("manage")) {
    const aliases: Record<string, string> = { "display-options-feed": "edit-feed", "display-options-group": "edit-group", "add-to-blacklist": "blacklist" };
    const requested = query.get("manage") || "preferences";
    const kind = Object.hasOwn(aliases, requested) ? aliases[requested] : requested;
    const supported = new Set(["preferences", "add-feed", "edit-feed", "delete-feed", "add-group", "edit-group", "delete-group", "edit-sparks", "delete-sparks", "auth-feed", "blacklist", "import", "export", "maintenance"]);
    const params = new URLSearchParams({ dialog: supported.has(kind) ? kind : "preferences" });
    const feedId = query.get("feedId") ?? query.get("feed_id") ?? (kind.includes("feed") ? query.get("id") : null);
    const groupId = query.get("groupId") ?? query.get("group_id") ?? (kind.includes("group") ? query.get("id") : null);
    if (feedId !== null) params.set("feedId", String(integer(feedId, "feedId", 1)));
    if (groupId !== null) params.set("groupId", String(integer(groupId, "groupId", 1)));
    return redirect("", params);
  }
  if (query.has("logout")) return redirect("login", new URLSearchParams({ action: "logout" }));
  if (query.has("refresh")) return redirect("extras", new URLSearchParams({ section: "refresh" }));
  for (const name of ["shortcuts", "extras", "blacklist"] as const) if (query.has(name)) return redirect(name);
  if (["updates", "update", "updated", "revert"].some(name => query.has(name))) return redirect("updated");
  return redirect("");
}

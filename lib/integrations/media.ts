import "server-only";
import { and, eq, or } from "drizzle-orm";
import { parseDocument } from "htmlparser2";
import { getElementsByTagName } from "domutils";
import { assertOwner, type OwnerContext } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { favicons, feedCredentials, feeds, items } from "@/lib/db/schema";
import { getConfig } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { fetchSafeImage, sanitizeContent, sanitizeImage } from "@/lib/ingest";
import { HttpError, privateHeaders } from "./http";

export async function faviconResponse(owner: OwnerContext, id: number): Promise<Response> {
  await assertOwner(owner);
  const icons = await getDb().select().from(favicons).where(and(eq(favicons.ownerId, owner.id), or(eq(favicons.id, id), eq(favicons.isDefault, true))));
  const icon = icons.find(row => row.id === id) ?? icons.find(row => row.isDefault);
  if (!icon) throw new HttpError("The favicon is unavailable.", 404, "FAVICON_NOT_FOUND");
  const safe = await sanitizeImage(icon.data, "", true);
  return new Response(new Uint8Array(safe.bytes), { headers: { ...privateHeaders, "Content-Type": safe.mime, "Content-Length": String(safe.bytes.length), "Content-Security-Policy": "default-src 'none'; sandbox" } });
}

/** Only a URL that belongs to this owner's stored sanitized article may be fetched. */
export async function mediaResponse(owner: OwnerContext, itemId: number, rawUrl: string): Promise<Response> {
  await assertOwner(owner);
  if (rawUrl.length > 8192) throw new HttpError("The image URL is too long.");
  const [row] = await getDb().select({ feedId: feeds.id, html: items.html, rawHtml: items.rawHtml, articleUrl: items.url, feedUrl: feeds.url }).from(items).innerJoin(feeds, eq(feeds.id, items.feedId)).where(and(eq(items.id, itemId), eq(feeds.ownerId, owner.id))).limit(1);
  if (!row) throw new HttpError("The article no longer exists.", 404, "ITEM_NOT_FOUND");
  let requested: URL;
  try { requested = new URL(rawUrl); } catch { throw new HttpError("The image URL is invalid."); }
  requested.hash = "";
  const document = parseDocument(sanitizeContent(row.rawHtml || row.html, "rich", row.articleUrl || row.feedUrl));
  const urls = new Set<string>();
  for (const tag of ["img", "video"]) for (const element of getElementsByTagName(tag, document.children, true)) {
    const value = element.attribs[tag === "img" ? "src" : "poster"];
    if (!value) continue;
    try { const url = new URL(value, row.articleUrl || row.feedUrl); url.hash = ""; urls.add(url.href); } catch { /* An invalid stored attribute is never eligible. */ }
  }
  if (!urls.has(requested.href)) throw new HttpError("The image is not associated with this article.", 403, "MEDIA_NOT_ASSOCIATED");
  let credentials: { username: string; password: string } | undefined;
  const sameOrigin = requested.origin === new URL(row.feedUrl).origin;
  if (sameOrigin) {
    const [secret] = await getDb().select({ ciphertext: feedCredentials.ciphertext }).from(feedCredentials).where(eq(feedCredentials.feedId, row.feedId)).limit(1);
    if (secret) {
      const value: unknown = JSON.parse(decryptSecret(secret.ciphertext, `feed:${row.feedId}`));
      if (!value || typeof value !== "object" || !("username" in value) || !("password" in value) || typeof value.username !== "string" || typeof value.password !== "string") throw new Error("Invalid feed credential record.");
      credentials = { username: value.username, password: value.password };
    }
  }
  // Only the original feed origin can receive its own credentials or private-origin exception.
  const privateOrigins = sameOrigin ? getConfig().allowedPrivateOrigins.filter(origin => origin === requested.origin) : [];
  const safe = await fetchSafeImage(requested.href, { credentials, privateOrigins });
  return new Response(new Uint8Array(safe.bytes), { headers: { ...privateHeaders, "Content-Type": safe.mime, "Content-Length": String(safe.bytes.length), "Content-Security-Policy": "default-src 'none'; sandbox" } });
}

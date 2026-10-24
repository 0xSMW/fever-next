import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { parseDocument } from "htmlparser2";
import { getElementsByTagName, getOuterHTML } from "domutils";
import { getDb } from "@/lib/db/client";
import { feeds, installation, items, owners, readerPreferences } from "@/lib/db/schema";
import { getConfig } from "@/lib/config";
import { sanitizeContent } from "@/lib/ingest";
import { HttpError, xmlText } from "./http";

/** Public publishing is deliberate and independent of browser authentication. */
export async function savedRss(): Promise<Response> {
  const db = getDb();
  const [setting] = await db.select({ ownerId: owners.id, share: readerPreferences.share, shareProtected: readerPreferences.shareProtected }).from(owners).innerJoin(readerPreferences, eq(readerPreferences.ownerId, owners.id)).limit(1);
  const [installed] = await db.select({ baseUrl: installation.baseUrl, status: installation.status }).from(installation).where(eq(installation.id, 1)).limit(1);
  if (!setting?.share || installed?.status !== "ready") throw new HttpError("This feed is not published.", 404, "RSS_DISABLED");
  const base = installed.baseUrl ?? getConfig().baseUrl;
  if (!base) throw new Error("The installation base URL is not configured.");
  const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error("Invalid publication base URL.");
  const rows = await db.select({ item: items, feedUrl: feeds.url }).from(items).innerJoin(feeds, eq(feeds.id, items.feedId)).where(and(eq(feeds.ownerId, setting.ownerId), eq(items.isSaved, true), ...(setting.shareProtected ? [] : [eq(feeds.requiresAuth, false)]))).orderBy(desc(items.publishedAt), desc(items.id)).limit(30);
  const installationName = baseUrl.hostname.replace(/^www\./, "");
  const legacyDirectory = baseUrl.pathname.replace(/\/$/, "");
  const entries = rows.map(({ item, feedUrl }) => {
    let link = "";
    try { const url = new URL(item.url); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) link = url.href; } catch { /* Keep malformed imported URLs out of publication. */ }
    const articleBaseUrl = link || baseUrl.href;
    // Subscription addresses can contain publisher access tokens even without Basic auth.
    // A published article never exposes its secret subscription URL through a link or image.
    let secretFeedUrl: string | undefined;
    try { const source = new URL(feedUrl); if (source.search || source.username || source.password) { source.hash = ""; secretFeedUrl = source.href; } } catch { /* Invalid source URLs are not emitted here. */ }
    const isSecretFeedUrl = (value: string | undefined) => {
      if (!secretFeedUrl || !value) return false;
      try { const candidate = new URL(value); candidate.hash = ""; return candidate.href === secretFeedUrl; } catch { return false; }
    };
    if (isSecretFeedUrl(link)) link = "";
    const document = parseDocument(sanitizeContent(item.rawHtml || item.html, "rich", articleBaseUrl));
    if (secretFeedUrl) for (const tag of ["a", "img", "audio", "video", "source", "track"]) for (const element of getElementsByTagName(tag, document.children, true)) {
      for (const name of ["href", "src", "poster"]) if (isSecretFeedUrl(element.attribs[name])) delete element.attribs[name];
    }
    const html = getOuterHTML(document);
    return `<item><title>${xmlText(item.title)}</title><description>${xmlText(html)}</description><link>${xmlText(link)}</link><guid isPermaLink="false">${xmlText(`${item.id}@${installationName}${legacyDirectory}`)}</guid><pubDate>${xmlText(new Date(item.publishedAt * 1000).toUTCString())}</pubDate></item>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xmlText(`${installationName}’s Saved Items`)}</title><link>${xmlText(baseUrl.href)}</link><description></description>${entries.join("")}</channel></rss>`;
  // No shared cache: disabling publication or rotating privacy policy takes effect immediately.
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

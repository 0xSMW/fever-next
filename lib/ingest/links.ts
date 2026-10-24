import {
  assertNoLegacyUrlCollisions,
  canonicalUrlKey,
  checksum,
  LEGACY_URL_VERSION,
  legacyLower,
  normalizeUrl,
  resolveLegacyUrl,
  trueUrl,
} from "../legacy-url";
import type { CompiledBlacklist } from "../domain/blacklist";

export const HOT_RANKING_VERSION = 1;

/** Compatibility data from fever.php parse_links(), not a general URL blocklist. */
export const LEGACY_IGNORED_LINKS = Object.freeze([
  "feedburner.com/fb/a/emailFlare",
  "referpals.com/apps/rd.aspx",
  "slashdot.org/submit.pl",
  "netscape.com/signin/",
  "furl.net/members/login",
  "newsvine.com/_tools/user/login",
  "ma.gnolia.com/signin",
  "secure.del.icio.us/login",
  "del.icio.us/post",
  "reddit.com/submit",
  "digg.com/submit",
  "facebook.com/share.php",
  "technorati.com/faves",
  "google.com/bookmarks/mark",
  "stumbleupon.com/submit",
]);

export interface LinkExtractionItem {
  id: number; feedId: number; title: string; url: string; html: string; publishedAt: number;
}
export interface LinkExtractionFeed { id: number; siteUrl: string; domain: string; }
export interface LinkOccurrenceInput {
  feedId: number;
  itemId: number;
  originalUrl: string;
  url: string;
  canonicalUrl: string;
  urlKey: string;
  urlChecksum: number;
  titleUrlChecksum: number;
  title: string;
  isItem: boolean;
  isLocal: boolean;
  isBlacklisted: boolean;
  isFirst: boolean;
  weight: number;
  createdAt: number;
  normalizationVersion: number;
  rankingVersion: number;
}

/** PHP trim() removes this byte set, not every Unicode whitespace character. */
function legacyTrim(value: string): string { return value.replace(/^[ \t\n\r\0\x0b]+|[ \t\n\r\0\x0b]+$/g, ""); }

function removePairedElement(value: string, tag: "script" | "style"): string {
  const lower = legacyLower(value);
  let output = "";
  let cursor = 0;
  for (;;) {
    const open = lower.indexOf(`<${tag}`, cursor);
    if (open < 0) return output + value.slice(cursor);
    const end = lower.indexOf(`</${tag}>`, open + tag.length + 1);
    if (end < 0) return output + value.slice(cursor);
    const openingEnd = value.indexOf(">", open + tag.length + 1);
    if (openingEnd < 0 || openingEnd >= end) return output + value.slice(cursor);
    output += value.slice(cursor, open);
    cursor = end + tag.length + 3;
  }
}

function stripLegacyTags(value: string): string {
  const html = removePairedElement(removePairedElement(value, "script"), "style");
  let text = "";
  let position = 0;
  while (position < html.length) {
    if (html[position] !== "<") { text += html[position++]; continue; }
    if (/\s/.test(html[position + 1] ?? "")) { text += html[position++]; continue; }
    if (html.startsWith("<!--", position)) {
      const end = html.indexOf("-->", position + 4);
      position = end < 0 ? html.length : end + 3;
      continue;
    }
    let quote = "";
    position += 1;
    while (position < html.length) {
      const char = html[position++];
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
  }
  return text;
}

/**
 * A forward-only scanner for the legacy quoted-href selector. It preserves
 * attribute entities and inner markup without executing a potentially
 * quadratic backtracking expression over publisher-controlled HTML.
 */
function* legacyAnchors(html: string): Generator<{ href: string; inner: string }> {
  const lower = legacyLower(html);
  let cursor = 0;
  while (cursor < html.length) {
    const open = lower.indexOf("<a", cursor);
    if (open < 0) return;
    const initialEnd = html.indexOf(">", open + 2);
    if (initialEnd < 0) return;
    let attribute = lower.indexOf("href", open + 3); // source requires [^>]+ before href
    let valueStart = -1;
    let quote = "";
    while (attribute >= 0 && attribute < initialEnd) {
      let position = attribute + 4;
      while (/[ \t\n\r\f\v]/.test(html[position] ?? "")) position += 1;
      if (html[position] === "=") {
        position += 1;
        while (/[ \t\n\r\f\v]/.test(html[position] ?? "")) position += 1;
        if (html[position] === '"' || html[position] === "'") {
          quote = html[position];
          valueStart = position + 1;
          break;
        }
      }
      attribute = lower.indexOf("href", attribute + 4);
    }
    if (valueStart < 0) { cursor = initialEnd + 1; continue; }
    const valueEnd = html.indexOf(quote, valueStart);
    if (valueEnd < 0) return;
    if (html.slice(valueStart, valueEnd).includes("\x01")) { cursor = initialEnd + 1; continue; }
    const openingEnd = html.indexOf(">", valueEnd + 1);
    if (openingEnd < 0) return;
    const close = lower.indexOf("</a>", openingEnd + 1);
    if (close < 0) return;
    yield { href: html.slice(valueStart, valueEnd), inner: html.slice(openingEnd + 1, close) };
    cursor = close + 4;
  }
}

function ignoredAnchor(url: string): boolean {
  if (/^(?:[ \t\n\r\f\v]*$|#|mailto:|\/login|https?:\/\/[ \t\n\r\f\v]*$)/i.test(url)) return true;
  const lowered = legacyLower(url);
  // Legacy's (...).+ requires at least one following character. The exact
  // terminal ignore string alone is therefore retained, intentionally.
  return LEGACY_IGNORED_LINKS.some((ignored) => {
    const needle = legacyLower(ignored);
    for (let index = lowered.indexOf(needle); index >= 0; index = lowered.indexOf(needle, index + needle.length)) {
      if (index + ignored.length < url.length && url[index + ignored.length] !== "\n") return true;
    }
    return false;
  });
}

/**
 * Extract from the retained source HTML, before render sanitization. The quoted
 * href selector and entity-preserving titles mirror the legacy regex, including
 * duplicate anchors. These are ranking inputs, never trusted render HTML.
 */
export function extractLinkOccurrences(
  item: LinkExtractionItem,
  feed: LinkExtractionFeed,
  blacklist?: CompiledBlacklist,
  options: { requestIsHttps?: boolean } = {},
): LinkOccurrenceInput[] {
  if (item.feedId !== feed.id) throw new TypeError("Item and link feed IDs must agree");
  if (!Number.isSafeInteger(item.id) || item.id <= 0 || !Number.isSafeInteger(feed.id) || feed.id <= 0
    || !Number.isSafeInteger(item.publishedAt) || item.publishedAt < 0) throw new TypeError("Invalid occurrence identity or time");
  // Ingress must report oversized source data, never silently truncate ranking.
  if (Buffer.byteLength(item.html, "utf8") > 8 * 1024 * 1024) throw new RangeError("Link extraction HTML exceeds 8 MiB");
  const links: LinkOccurrenceInput[] = [];
  const append = (originalUrl: string, url: string, title: string, isItem: boolean) => {
    if (Buffer.byteLength(url, "utf8") > 65_536) throw new RangeError("Occurrence URL exceeds 64 KiB");
    const canonicalUrl = normalizeUrl(url);
    if (isItem && (canonicalUrl === "" || canonicalUrl === "0")) return;
    links.push({
      feedId: feed.id,
      itemId: item.id,
      originalUrl,
      url,
      canonicalUrl,
      urlKey: canonicalUrlKey(canonicalUrl),
      urlChecksum: checksum(canonicalUrl),
      titleUrlChecksum: checksum(title + canonicalUrl),
      title,
      isItem,
      isLocal: feed.domain === canonicalUrl.replace(/\/.*$/, ""),
      isBlacklisted: blacklist?.matches(url) ?? false,
      isFirst: false,
      weight: 0,
      createdAt: item.publishedAt,
      normalizationVersion: LEGACY_URL_VERSION,
      rankingVersion: HOT_RANKING_VERSION,
    });
  };
  append(item.url, trueUrl(item.url), item.title, true);

  // PHP's U modifier makes its quantifiers lazy; [^\1] means not byte 0x01.
  for (const anchor of legacyAnchors(item.html)) {
    const originalUrl = anchor.href;
    if (ignoredAnchor(originalUrl)) continue;
    const title = legacyTrim(stripLegacyTags(anchor.inner));
    if (title === "" || title === "0") continue;
    append(originalUrl, resolveLegacyUrl(feed.siteUrl, trueUrl(originalUrl), options.requestIsHttps), title, false);
  }
  return links;
}

export interface WeightableOccurrence {
  id: number;
  feedId: number;
  canonicalUrl: string;
  urlKey?: string;
  urlChecksum?: number;
  url: string;
  isItem: boolean;
  isLocal: boolean;
  createdAt: number;
}

/**
 * Feed refresh, link replacement, and expiration must apply this to ALL retained
 * occurrences of each affected feed. Equal-time order was unspecified in MySQL;
 * occurrence ID ascending is this version's documented deterministic tie rule.
 */
export function weightFeedLinks<T extends WeightableOccurrence>(links: readonly T[]): Array<T & { weight: number; isFirst: boolean }> {
  assertNoLegacyUrlCollisions(links.map((link) => ({
    canonicalUrl: link.canonicalUrl,
    canonicalKey: link.urlKey,
    legacyUrlChecksum: link.urlChecksum ?? checksum(link.canonicalUrl),
  })));
  const ordered = [...links].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const feeds = new Map<number, Map<number, number>>();
  return ordered.map((link) => {
    let weights = feeds.get(link.feedId);
    if (!weights) { weights = new Map(); feeds.set(link.feedId, weights); }
    // Keep imported ranking's CRC grouping after the collision check. Do not
    // silently rewrite historical checksum metadata while reweighting.
    const legacyChecksum = link.urlChecksum ?? checksum(link.canonicalUrl);
    const previous = weights.get(legacyChecksum);
    const isFirst = previous === undefined;
    const weight = previous === undefined
      ? ((link.isLocal && !link.isItem) || /^https?:\/\/feeds.feedburner.com/i.test(link.url) ? 1 : 0)
      : previous + 1;
    weights.set(legacyChecksum, weight);
    return { ...link, weight, isFirst };
  });
}

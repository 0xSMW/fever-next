import "server-only";
import type { HotLinkDTO, ItemDTO } from "../contracts";
import { getPool } from "../db/client";
import { safeInteger, toBoolean, toChecksum, toCount, toEpochSeconds, toFiniteNumber, toId } from "../db/numbers";
import { excerpt, sanitizeContent } from "../ingest/content";
import { assertNoLegacyUrlCollisions, legacyLower, LegacyUrlCollisionError } from "../legacy-url";

export { normalizeUrl, trueUrl, checksum } from "../legacy-url";
export const HOT_PIPELINE_VERSION = 1;
const DAY = 86_400;
const SCALE = 1.25;

export interface HotOwner { id: number; email: string; }
export interface HotOptions {
  offset?: number;
  range?: number;
  page?: number;
  perPage?: number;
  useCelsius?: boolean;
  /** Reader passes its device's established session boundary; API may omit. */
  lastSessionAt?: number;
}
export interface HotPage {
  links: HotLinkDTO[];
  page: number;
  perPage: number;
  /** Number of ranked candidates BEFORE the strict >1.25 filter. */
  totalCandidates: number;
  hasMore: boolean;
  start: number;
  end: number;
}
export interface HotOccurrence {
  id: number;
  feedId: number;
  itemId: number;
  url: string;
  canonicalUrl: string;
  urlKey: string;
  urlChecksum: number;
  title: string;
  createdAt: number;
  isItem: boolean;
  isLocal: boolean;
  isFirst: boolean;
  isBlacklisted: boolean;
  weight: number;
}
export interface HotCandidate { urlChecksum: number; score: number; }
export interface HotSnapshot { occurrences: readonly HotOccurrence[]; items: readonly ItemDTO[]; }
interface HotWindow { offset: number; range: number; page: number; perPage: number; useCelsius: boolean; start: number; end: number; skip: number; }

function hotWindow(options: HotOptions, frozenNow: number): HotWindow {
  const now = toEpochSeconds(frozenNow, "Hot clock");
  const offset = safeInteger(options.offset ?? 0, "Hot offset", 0, 36_500);
  const range = safeInteger(options.range ?? 7, "Hot range", 1, 36_500);
  const page = safeInteger(options.page ?? 1, "Hot page", 1, 1_000_000);
  const perPage = safeInteger(options.perPage ?? 20, "Hot page size", 1, 200);
  const useCelsius = options.useCelsius ?? false;
  if (typeof useCelsius !== "boolean") throw new TypeError("Hot temperature preference must be boolean");
  const start = now - offset * DAY;
  return { offset, range, page, perPage, useCelsius, start, end: start - range * DAY, skip: (page - 1) * perPage };
}

function inScoringWindow(link: HotOccurrence, window: HotWindow): boolean {
  return link.createdAt > window.end && (window.offset === 0 || link.createdAt < window.start);
}

function assertIdentities(links: readonly HotOccurrence[]): void {
  assertNoLegacyUrlCollisions(links.map((link) => ({
    canonicalUrl: link.canonicalUrl, canonicalKey: link.urlKey, legacyUrlChecksum: link.urlChecksum,
  })));
}

/** First appearance breaks a frequency tie; PHP's older equal-key sort was unspecified. */
function byFrequency(values: readonly string[]): Array<{ title: string; count: number }> {
  const counts = new Map<string, { title: string; count: number }>();
  for (const title of values) {
    const key = legacyLower(title);
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { title, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

// PHP's HTML_ENTITIES / ISO-8859-1 / ENT_COMPAT table, preserving &apos; and
// non-Latin-1 HTML5 entity spellings. Numeric entities are decoded first.
const latinOneEntities = [
  "nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect", "uml", "copy", "ordf", "laquo", "not", "shy", "reg", "macr",
  "deg", "plusmn", "sup2", "sup3", "acute", "micro", "para", "middot", "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
  "Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil", "Egrave", "Eacute", "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml",
  "ETH", "Ntilde", "Ograve", "Oacute", "Ocirc", "Otilde", "Ouml", "times", "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute", "THORN", "szlig",
  "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil", "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml",
  "eth", "ntilde", "ograve", "oacute", "ocirc", "otilde", "ouml", "divide", "oslash", "ugrave", "uacute", "ucirc", "uuml", "yacute", "thorn", "yuml",
];
const entityMap = new Map(latinOneEntities.map((name, index) => [name, String.fromCharCode(index + 160)]));
for (const [name, character] of [["quot", '"'], ["amp", "&"], ["lt", "<"], ["gt", ">"]]) entityMap.set(name, character);
const legacyControlPoints = [8364, 160, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 160, 381, 160,
  160, 8216, 8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 160, 382, 376];

function decodedTitleBytes(title: string): number {
  const numeric = title.replace(/&#(?:x0*([0-9a-f]+)|0*([0-9]+));/gi, (original, hex: string | undefined, decimal: string | undefined) => {
    let code = Number.parseInt(hex ?? decimal ?? "0", hex === undefined ? 10 : 16);
    if (code >= 128 && code < 160) code = legacyControlPoints[code - 128];
    if (!Number.isFinite(code) || code < 0 || code >= 2_097_152) return "";
    // The old helper emitted invalid four-byte UTF-8 above Unicode's maximum.
    // Only byte LENGTH is used here; a four-byte scalar preserves that length
    // without propagating invalid Unicode into a browser-facing string.
    return String.fromCodePoint(code > 0x10ffff ? 0x100000 : code);
  });
  return Buffer.byteLength(numeric.replace(/&([a-zA-Z0-9]+);/g, (original, name: string) => entityMap.get(name) ?? original), "utf8");
}

function wordsInUrl(title: string, url: string): number {
  // Do not filter cleaned empty tokens: legacy turns numeric-only tokens into
  // an empty regex alternative. That observable oddity affects title choice.
  const tokens = title.split(/\b[^a-z0-9]* |-/i)
    .filter((token) => token !== "" && token !== "0")
    .map((token) => legacyLower(token.replace(/[^a-z]+/gi, "")));
  const pattern = new RegExp(`(${tokens.join("|")})`, "g");
  // Legacy regex has no Unicode modifier: empty matches count UTF-8 bytes.
  const bytes = Buffer.from(legacyLower(url), "utf8").toString("latin1");
  return [...bytes.matchAll(pattern)].length;
}

function bestWordTitle(titles: readonly { title: string; count: number }[], url: string): { title: string; count: number } | undefined {
  return titles.map(({ title }) => ({ title, count: wordsInUrl(title, url) })).sort((a, b) => b.count - a.count)[0];
}

function inferredTitle(linkTitles: readonly string[], itemTitles: readonly string[], url: string): string {
  const anchors = byFrequency(linkTitles);
  if ((anchors[0]?.count ?? 0) > 1) return anchors[0].title;
  const items = byFrequency(itemTitles);
  if ((items[0]?.count ?? 0) > 1) return items[0].title;
  const anchorWords = bestWordTitle(anchors, url);
  if (anchorWords && anchorWords.count > 0) return anchorWords.title;
  const itemWords = bestWordTitle(items, url);
  if (itemWords && itemWords.count > 0) return itemWords.title;
  return items[0]?.title ?? "";
}

/** PHP number_format uses decimal half-away-from-zero, not banker's rounding. */
export function hotTemperature(score: number, useCelsius: boolean): number {
  const fahrenheit = (98.6 - SCALE) + toFiniteNumber(score, "Hot score");
  const degrees = useCelsius ? (fahrenheit - 32) * 5 / 9 : fahrenheit;
  // Match the source's number_format(..., 1) on the oracle runtime. An epsilon
  // changes genuine below-half results such as 97.44999999999999 to 97.5.
  const scaled = Math.abs(degrees) * 10;
  const rounded = Math.floor(scaled + 0.5) / 10;
  return degrees < 0 ? -rounded : rounded;
}

function sourceOrder(a: HotOccurrence, b: HotOccurrence): number {
  return b.createdAt - a.createdAt || Number(b.isItem) - Number(a.isItem) || a.id - b.id;
}

/** Repeated IDs keep their first insertion position, matching key_remap(). */
function collectSources(links: readonly HotOccurrence[], candidates: readonly HotCandidate[], window: HotWindow): HotOccurrence[] {
  const wanted = new Set(candidates.map((candidate) => candidate.urlChecksum));
  const scoped = links.filter((link) => wanted.has(link.urlChecksum) && !link.isBlacklisted && inScoringWindow(link, window)).sort(sourceOrder);
  // Deliberately no blacklist/window filter for the source's second query.
  const originals = links.filter((link) => wanted.has(link.urlChecksum) && link.isLocal && link.isItem).sort(sourceOrder);
  const merged = new Map<number, HotOccurrence>();
  for (const link of [...scoped, ...originals]) merged.set(link.id, link);
  return [...merged.values()];
}

function prefers(candidate: HotOccurrence, current: HotOccurrence): boolean {
  return (!current.isItem && candidate.isItem)
    || (current.isItem === candidate.isItem && !current.isLocal && candidate.isLocal)
    || (current.isItem === candidate.isItem && current.isLocal === candidate.isLocal && current.createdAt > candidate.createdAt);
}

function assembleHotLinks(candidates: readonly HotCandidate[], sources: readonly HotOccurrence[], sourceItems: readonly ItemDTO[], window: HotWindow): HotLinkDTO[] {
  const items = new Map(sourceItems.map((item) => [item.id, item]));
  const occurrences = new Map<number, HotOccurrence[]>();
  for (const occurrence of sources) {
    const group = occurrences.get(occurrence.urlChecksum) ?? [];
    group.push(occurrence);
    occurrences.set(occurrence.urlChecksum, group);
  }
  const temperatures = new Map<number, HotLinkDTO[]>();
  for (const candidate of candidates) {
    const associated = occurrences.get(candidate.urlChecksum);
    if (!associated?.length) throw new Error("Hot candidate has no occurrences in the current snapshot");
    let representative = associated[0];
    const itemTitles: string[] = [];
    const linkTitles: string[] = [];
    const uniqueItems = new Map<number, ItemDTO>();
    for (const link of associated) {
      if (prefers(link, representative)) representative = link;
      const item = items.get(link.itemId);
      if (!item) throw new Error("Hot occurrence references an unavailable item in the current snapshot");
      uniqueItems.set(item.id, item);
      itemTitles.push(item.title);
      if (link.title !== "[link]" && decodedTitleBytes(link.title) > 1) linkTitles.push(link.title);
    }
    const backing = items.get(representative.itemId);
    if (!backing) throw new Error("Hot representative item is unavailable");
    const isItem = representative.isItem;
    // Source uses occurrence title, preserved when the article later changes.
    const title = isItem ? representative.title : inferredTitle(linkTitles, itemTitles, representative.url);
    const html = isItem && representative.isLocal
      ? backing.html.trim().replace(/<div><a title="Perma(nent )?link.+<\/a><\/div>$/, "")
      : "";
    // Source's alternate-description fallback is commented out; leave empty.
    const contributing = [...uniqueItems.values()].filter((item) => item.publishedAt <= window.start && item.publishedAt >= window.end);
    const temperature = hotTemperature(candidate.score, window.useCelsius);
    const dto: HotLinkDTO = {
      id: representative.id, feedId: representative.feedId, itemId: representative.itemId,
      title, url: representative.url, html, temperature, isItem, isLocal: representative.isLocal,
      isSaved: isItem ? backing.isSaved : false,
      itemIds: contributing.map((item) => item.id), sources: contributing,
    };
    const group = temperatures.get(temperature) ?? [];
    group.push(dto);
    temperatures.set(temperature, group);
  }
  // Preserve score order within each rounded temperature; stable partition.
  return [...temperatures.values()].flatMap((links) => [
    ...links.filter((link) => link.isItem && link.isLocal),
    ...links.filter((link) => !(link.isItem && link.isLocal)),
  ]);
}

function makePage(links: HotLinkDTO[], window: HotWindow, totalCandidates: number): HotPage {
  return { links, page: window.page, perPage: window.perPage, totalCandidates,
    hasMore: links.length > 0 && window.skip + window.perPage < totalCandidates, start: window.start, end: window.end };
}

/** Pure ten-phase oracle input for immutable fixtures with a frozen clock. */
export function rankHotSnapshot(snapshot: HotSnapshot, options: HotOptions, frozenNow: number): HotPage {
  const window = hotWindow(options, frozenNow);
  assertIdentities(snapshot.occurrences);
  const scores = new Map<number, number>();
  for (const link of snapshot.occurrences) {
    if (!link.isFirst || link.isBlacklisted || !inScoringWindow(link, window)) continue;
    const weight = safeInteger(link.weight, "occurrence weight");
    scores.set(link.urlChecksum, (scores.get(link.urlChecksum) ?? 0) + SCALE / 2 ** weight);
  }
  const ranked = [...scores].map(([urlChecksum, score]) => ({ urlChecksum, score }))
    .sort((a, b) => b.score - a.score || a.urlChecksum - b.urlChecksum);
  const candidates = ranked.slice(window.skip, window.skip + window.perPage).filter((candidate) => candidate.score > SCALE);
  const sources = collectSources(snapshot.occurrences, candidates, window);
  return makePage(assembleHotLinks(candidates, sources, snapshot.items, window), window, ranked.length);
}

function occurrenceFromRow(row: Record<string, unknown>): HotOccurrence {
  return {
    id: toId(row.id), feedId: toId(row.feed_id), itemId: toId(row.item_id),
    url: String(row.url), canonicalUrl: String(row.canonical_url), urlKey: String(row.url_key),
    urlChecksum: toChecksum(row.url_checksum), title: String(row.title), createdAt: toEpochSeconds(row.created_at),
    isItem: toBoolean(row.is_item), isLocal: toBoolean(row.is_local), isFirst: toBoolean(row.is_first),
    isBlacklisted: toBoolean(row.is_blacklisted), weight: safeInteger(row.weight, "occurrence weight"),
  };
}

function itemFromRow(row: Record<string, unknown>, lastSessionAt: number, defaultAllows: number): ItemDTO {
  const allows = safeInteger(row.feed_item_allows, "feed content option", -1, 2);
  const html = sanitizeContent(String(row.html), allows === -1 ? defaultAllows : allows, String(row.url));
  const addedAt = toEpochSeconds(row.added_at);
  const readAt = toEpochSeconds(row.read_at);
  return {
    id: toId(row.id), feedId: toId(row.feed_id), title: String(row.title), author: String(row.author),
    url: String(row.url), html, excerpt: excerpt(html), publishedAt: toEpochSeconds(row.published_at), addedAt, readAt,
    isSaved: toBoolean(row.is_saved), isNew: !toBoolean(row.is_saved) && readAt === 0 && addedAt > lastSessionAt,
    feedTitle: String(row.feed_title), faviconId: row.favicon_id == null ? 1 : toId(row.favicon_id),
  };
}

/**
 * One checked-out PostgreSQL connection, one Repeatable Read snapshot, and one
 * clock cover scoring, both source queries, item state, and representative
 * selection. Raw HTML and feed credentials never enter the result.
 */
export async function getHotPage(owner: HotOwner, options: HotOptions = {}): Promise<HotPage> {
  const ownerId = toId(owner.id, "owner ID");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const frozenNow = Math.floor(Date.now() / 1000);
    const preferences = await client.query<{ per_page: number; use_celsius: boolean; item_allows: number; last_session_at: string }>(
      `SELECT p.per_page, p.use_celsius, p.item_allows, COALESCE(v.last_session_at, 0) AS last_session_at
       FROM owner o JOIN reader_preferences p ON p.owner_id = o.id
       LEFT JOIN reader_view_state v ON v.owner_id = o.id AND v.device_id = 'default'
       WHERE o.id = $1 AND o.email = $2`, [ownerId, owner.email],
    );
    const preference = preferences.rows[0];
    if (!preference) throw new Error("Authenticated owner preferences were not found");
    const window = hotWindow({ ...options, perPage: options.perPage ?? preference.per_page, useCelsius: options.useCelsius ?? preference.use_celsius }, frozenNow);
    const lastSessionAt = toEpochSeconds(options.lastSessionAt ?? preference.last_session_at);

    // Keep legacy CRC grouping until migration proves collision freedom. Fail
    // visibly even for currently cold/blacklisted collisions; hiding a collision
    // behind the time window would make later grouping change silently.
    const collisions = await client.query<{ url_checksum: string }>(
      `SELECT l.url_checksum FROM link_occurrences l JOIN feeds f ON f.id = l.feed_id
       WHERE f.owner_id = $1 GROUP BY l.url_checksum HAVING count(DISTINCT l.canonical_url) > 1 LIMIT 1`, [ownerId],
    );
    if (collisions.rows[0]) throw new LegacyUrlCollisionError(toChecksum(collisions.rows[0].url_checksum));
    const digestCollision = await client.query(
      `SELECT l.url_key FROM link_occurrences l JOIN feeds f ON f.id = l.feed_id
       WHERE f.owner_id = $1 GROUP BY l.url_key HAVING count(DISTINCT l.canonical_url) > 1 LIMIT 1`, [ownerId],
    );
    if (digestCollision.rows.length) throw new Error("Canonical URL digest collision requires explicit reconciliation");

    const count = await client.query<{ total: string }>(
      `SELECT count(DISTINCT l.url_checksum) AS total FROM link_occurrences l JOIN feeds f ON f.id = l.feed_id
       WHERE f.owner_id = $1 AND NOT l.is_blacklisted AND l.is_first AND l.created_at > $2
         AND ($3::boolean OR l.created_at < $4)`, [ownerId, window.end, window.offset === 0, window.start],
    );
    const totalCandidates = toCount(count.rows[0].total);
    // The outer threshold MUST follow the inner ORDER BY/LIMIT/OFFSET. Empty
    // or short pages are compatible, and cannot be filled from later rows.
    const scored = await client.query<{ url_checksum: string; score: number }>(
      `SELECT paged.url_checksum, paged.score FROM (
         SELECT l.url_checksum,
           sum(CASE WHEN l.weight > 1023 THEN 0::double precision
                    ELSE 1.25::double precision / power(2::double precision, l.weight::double precision) END) AS score
         FROM link_occurrences l JOIN feeds f ON f.id = l.feed_id
         WHERE f.owner_id = $1 AND NOT l.is_blacklisted AND l.is_first AND l.created_at > $2
           AND ($3::boolean OR l.created_at < $4)
         GROUP BY l.url_checksum ORDER BY score DESC, l.url_checksum ASC LIMIT $5 OFFSET $6
       ) AS paged WHERE paged.score > 1.25 ORDER BY paged.score DESC, paged.url_checksum ASC`,
      [ownerId, window.end, window.offset === 0, window.start, window.perPage, window.skip],
    );
    const candidates = scored.rows.map((row) => ({ urlChecksum: toChecksum(row.url_checksum), score: toFiniteNumber(row.score) }));
    if (!candidates.length) {
      await client.query("COMMIT");
      return makePage([], window, totalCandidates);
    }
    const checksums = candidates.map((candidate) => candidate.urlChecksum);
    const scoped = await client.query(
      `SELECT l.* FROM link_occurrences l JOIN feeds f ON f.id = l.feed_id
       WHERE f.owner_id = $1 AND l.url_checksum = ANY($2::bigint[]) AND NOT l.is_blacklisted
         AND l.created_at > $3 AND ($4::boolean OR l.created_at < $5)
       ORDER BY l.created_at DESC, l.is_item DESC, l.id ASC`,
      [ownerId, checksums, window.end, window.offset === 0, window.start],
    );
    const originals = await client.query(
      `SELECT l.* FROM link_occurrences l JOIN feeds f ON f.id = l.feed_id
       WHERE f.owner_id = $1 AND l.url_checksum = ANY($2::bigint[]) AND l.is_local AND l.is_item
       ORDER BY l.created_at DESC, l.is_item DESC, l.id ASC`, [ownerId, checksums],
    );
    const merged = new Map<number, HotOccurrence>();
    for (const row of [...scoped.rows, ...originals.rows]) {
      const occurrence = occurrenceFromRow(row);
      merged.set(occurrence.id, occurrence);
    }
    const sourceOccurrences = [...merged.values()];
    const itemIds = [...new Set(sourceOccurrences.map((link) => link.itemId))];
    const rows = await client.query(
      `SELECT i.id, i.feed_id, i.title, i.author, i.url, i.html, i.published_at, i.added_at, i.read_at, i.is_saved,
         COALESCE(NULLIF(f.custom_title, ''), NULLIF(f.title, ''), f.url) AS feed_title, f.favicon_id, f.item_allows AS feed_item_allows
       FROM items i JOIN feeds f ON f.id = i.feed_id WHERE f.owner_id = $1 AND i.id = ANY($2::bigint[])`, [ownerId, itemIds],
    );
    const items = rows.rows.map((row) => itemFromRow(row, lastSessionAt, safeInteger(preference.item_allows, "content option", 0, 2)));
    const links = assembleHotLinks(candidates, sourceOccurrences, items, window);
    await client.query("COMMIT");
    return makePage(links, window, totalCandidates);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

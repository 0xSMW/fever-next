import type { FeedCandidate } from "@/lib/contracts";
import { safeExternalUrl } from "./return-path";

/** A feed the bookmarklet found in the page, from the query string. */
export interface SuppliedFeed { url: string; title: string; type: "feed" | "link" | "a" }

export interface FeedletRequest {
  /** The page the Feedlet ran on, when it is a safe http(s) URL. */
  pageUrl: string | null;
  pageTitle: string;
  supplied: SuppliedFeed[];
  /** Entries dropped because their URL was unusable. */
  rejected: number;
}

export interface CandidateVariant {
  url: string;
  title: string;
  /** Menu label: the format part of the title plus a short URL. */
  label: string;
  source: "page" | "server";
  guessed: boolean;
  subscribed: boolean;
  requiresAuth: boolean;
}

export interface CandidateGroup {
  key: string;
  title: string;
  variants: CandidateVariant[];
  /** Index of the subscribed variant if any, else the first (source behaviour). */
  defaultIndex: number;
}

type Params = Record<string, string | string[] | undefined>;

const MAX_SUPPLIED = 100;
const MAX_TITLE = 300;
/** feedlet.php: "Site (RSS 2.0)", "Atom feed", "RSS" are format variants of one feed. */
const FORMAT_PATTERN = /\s*\(?((?:rss|atom)(?:\s*[.0-9]*)?(?:\s*feeds?)?)\)?/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cleanTitle(value: string | undefined): string {
  // Titles are shown as text only. Collapse whitespace and drop any markup
  // the page put into an anchor title (source strip_tags_sane).
  return (value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

/** util.php rebuild_url: the source split "http" from "//host/path" to avoid filters. */
function rebuildUrl(value: string | undefined, protocol: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `${protocol && /^(https?|feed)$/i.test(protocol) ? protocol.toLowerCase() : "http"}://${trimmed.replace(/^\/\//, "")}`;
  return safeExternalUrl(withScheme);
}

const MAX_CANDIDATES_JSON = 65536;

/**
 * The modern query format: `candidates` is a JSON array of
 * `{url,title,type,subscribed,guessed}` (FeedCandidate), written by the
 * compat bookmarklet and by the compat redirect for legacy `feeds[n][...]`
 * links. `subscribed` comes from the page and is ignored; the server's
 * subscription list decides it. Returns null when the value is not an array.
 */
function parseCandidatesJson(value: string | undefined): Array<{ href?: string; protocol?: string; title?: string; type?: string }> | null {
  if (!value || value.length > MAX_CANDIDATES_JSON) return value ? null : [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.slice(0, MAX_SUPPLIED).map((entry) => {
    if (!entry || typeof entry !== "object") return {};
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    return {
      href: typeof record.url === "string" ? record.url : undefined,
      title: typeof record.title === "string" ? record.title : undefined,
      type: record.guessed === true ? "a" : type === "a" || type === "feed" ? type : "link",
    };
  });
}

/** Parse the source (`feeds[n][href,protocol,title,type]`) and modern (`candidates` JSON) Feedlet query formats. */
export function parseFeedletParams(params: Params): FeedletRequest {
  const pageUrl = rebuildUrl(first(params.url), first(params.protocol));
  const pageTitle = cleanTitle(first(params.title));
  const entries = new Map<number, { href?: string; protocol?: string; title?: string; type?: string }>();
  for (const [key, raw] of Object.entries(params)) {
    const match = /^feeds\[(\d{1,4})\]\[(href|protocol|title|type)\]$/.exec(key);
    if (!match) continue;
    const index = Number(match[1]);
    if (index >= MAX_SUPPLIED) continue;
    const entry = entries.get(index) ?? {};
    entry[match[2] as "href" | "protocol" | "title" | "type"] = first(raw);
    entries.set(index, entry);
  }
  const fromJson = parseCandidatesJson(first(params.candidates));
  const ordered = [...[...entries.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry), ...(fromJson ?? [])];
  const supplied: SuppliedFeed[] = [];
  const seen = new Set<string>();
  // An unreadable candidates payload counts as one dropped entry so the page can say so.
  let rejected = fromJson ? 0 : 1;
  for (const entry of ordered) {
    if (supplied.length >= MAX_SUPPLIED) break;
    const url = rebuildUrl(entry.href, entry.protocol);
    if (!url) { rejected++; continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const type = entry.type === "a" || entry.type === "feed" ? entry.type : "link";
    supplied.push({ url, title: cleanTitle(entry.title) || "Feed", type });
  }
  return { pageUrl, pageTitle, supplied, rejected };
}

/**
 * Comparison key for "already subscribed": util.php normalize_url, the same
 * rules as lib/legacy-url.ts (which is server-only because it imports
 * node:crypto). Comparison only; never used for navigation.
 */
export function comparisonKey(value: string): string {
  return value
    .replace(/^(?:https?|feed):\/\/(?:www\.)?([^.]+\.)/i, "$1")
    .replace(/^[^/]+\//, (domain) => domain.replace(/[A-Z]/g, (letter) => letter.toLowerCase()))
    .replace(/\/index\.[a-z0-9]+/gi, "")
    .replace(/\/\?/g, "?")
    .replace(/\/$/, "");
}

/** Short URL for display: scheme and leading www removed. */
export function displayUrl(value: string): string {
  return value.replace(/^(?:https?|feed):\/\/(?:www\.)?/i, "").replace(/\/$/, "");
}

interface RawCandidate { url: string; title: string; source: "page" | "server"; guessed: boolean; subscribed: boolean; requiresAuth: boolean }

export function fromSupplied(feed: SuppliedFeed): RawCandidate {
  return { url: feed.url, title: feed.title, source: "page", guessed: feed.type === "a", subscribed: false, requiresAuth: false };
}

export function fromServer(candidate: FeedCandidate): RawCandidate | null {
  const url = safeExternalUrl(candidate.url);
  if (!url) return null;
  const extra = candidate as FeedCandidate & { requiresAuth?: unknown };
  return {
    url,
    title: cleanTitle(candidate.title) || "Feed",
    source: "server",
    guessed: !!candidate.guessed,
    subscribed: !!candidate.subscribed,
    requiresAuth: extra.requiresAuth === true || /auth/i.test(candidate.type ?? ""),
  };
}

/**
 * Group candidates the way feedlet.php did: titles that differ only by a
 * format suffix ("RSS", "Atom 1.0 feed") become one row with a Format menu.
 * Unlike the source, rows with the same plain title are merged as variants
 * instead of overwriting each other, so no candidate is silently lost.
 */
export function groupCandidates(raw: RawCandidate[], subscribedKeys: ReadonlySet<string>): CandidateGroup[] {
  const byUrl = new Map<string, RawCandidate>();
  for (const candidate of raw) {
    const existing = byUrl.get(candidate.url);
    if (!existing) { byUrl.set(candidate.url, { ...candidate }); continue; }
    // Same URL from page and server: a page-supplied link is not a guess if the server confirmed it.
    existing.guessed = existing.guessed && candidate.guessed;
    existing.subscribed ||= candidate.subscribed;
    existing.requiresAuth ||= candidate.requiresAuth;
    if (existing.title === "Feed" && candidate.title !== "Feed") existing.title = candidate.title;
  }

  const groups = new Map<string, CandidateGroup>();
  for (const candidate of byUrl.values()) {
    const match = FORMAT_PATTERN.exec(candidate.title);
    const groupTitle = match ? candidate.title.replace(match[0], "").trim() || "Feed" : candidate.title;
    const key = groupTitle.toLowerCase();
    const subscribed = candidate.subscribed || subscribedKeys.has(comparisonKey(candidate.url));
    const formatPart = candidate.title.replace(groupTitle, "").replace(/[()]/g, "").trim();
    const variant: CandidateVariant = {
      url: candidate.url,
      title: candidate.title,
      label: formatPart ? `${formatPart} (${displayUrl(candidate.url)})` : displayUrl(candidate.url),
      source: candidate.source,
      guessed: candidate.guessed,
      subscribed,
      requiresAuth: candidate.requiresAuth,
    };
    const group = groups.get(key) ?? { key, title: groupTitle, variants: [], defaultIndex: 0 };
    group.variants.push(variant);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const subscribedIndex = group.variants.findIndex((variant) => variant.subscribed);
    group.defaultIndex = subscribedIndex >= 0 ? subscribedIndex : 0;
  }
  return [...groups.values()];
}

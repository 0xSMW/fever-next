import type { FeedDTO, GroupDTO, Section } from "@/lib/contracts";

export const SECTION_LABELS: Record<Section, string> = {
  hot: "Hot", kindling: "Kindling", saved: "Saved", sparks: "Sparks", search: "Search",
};
export const SECTION_ORDER: Section[] = ["hot", "kindling", "saved", "sparks", "search"];

/** Hot window menus from fever.php ($hot_start/$hot_range); null marks a divider. */
export const HOT_START_OPTIONS: Array<[number, string] | null> = [
  [0, "now"], null, [1, "yesterday"], [2, "2 days ago"], [3, "3 days ago"], [4, "4 days ago"],
  [5, "5 days ago"], [6, "6 days ago"], null, [7, "a week ago"], [14, "2 weeks ago"],
  [21, "3 weeks ago"], [28, "4 weeks ago"], [35, "5 weeks ago"],
];
export const HOT_RANGE_OPTIONS: Array<[number, string] | null> = [
  [1, "day"], [2, "2 days"], [3, "3 days"], [4, "4 days"], [5, "5 days"], [6, "6 days"], null,
  [7, "week"], [14, "2 weeks"], [21, "3 weeks"], [28, "4 weeks"], null, [31, "month"],
];
export function hotStartLabel(value: number): string {
  return HOT_START_OPTIONS.find((entry) => entry?.[0] === value)?.[1] ?? `${value} days ago`;
}
export function hotRangeLabel(value: number): string {
  return HOT_RANGE_OPTIONS.find((entry) => entry?.[0] === value)?.[1] ?? `${value} days`;
}

/** util.php ago(); input is epoch seconds, `now` is epoch milliseconds. */
export function ago(seconds: number, now = Date.now()): string {
  if (!seconds) return "Never";
  let diff = Math.round(now / 1000 - seconds);
  if (diff < 60) return "Just now";
  diff = Math.round(diff / 60);
  if (diff < 60) return `${diff} minute${diff > 1 ? "s" : ""} ago`;
  diff = Math.round(diff / 60);
  if (diff < 24) return `${diff} hour${diff > 1 ? "s" : ""} ago`;
  diff = Math.round(diff / 24);
  if (diff < 7) return diff > 1 ? `${diff} days ago` : "Yesterday";
  diff = Math.round(diff / 7);
  if (diff < 12) return diff > 1 ? `${diff} weeks ago` : "Last week";
  if (diff < 52) return `Around ${Math.floor(diff / (30 / 7))} months ago`;
  diff = Math.round(diff / 52);
  return diff > 1 ? `Around ${diff} years ago` : "Last year";
}

export function absoluteDate(seconds: number): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ucfirst(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/** util.php widont(): join the last two words with a no-break space. */
export function widont(value: string): string {
  return value.replace(/(\S)\s+(\S+)\s*$/u, "$1 $2");
}

/** Display form of a URL for feeds without a title, after util.php normalize_url. */
export function displayUrl(value: string): string {
  return value
    .replace(/^(?:https?|feed):\/\/(?:www\.)?/i, "")
    .replace(/\/index\.[a-z0-9]+/gi, "")
    .replace(/\/\?/g, "?")
    .replace(/\/$/, "");
}

export function feedTitle(feed: Pick<FeedDTO, "title" | "url"> | undefined | null): string {
  if (!feed) return "Unknown feed";
  return feed.title.trim() ? feed.title : displayUrl(feed.url);
}

export function groupTitle(group: GroupDTO | undefined | null): string {
  return group?.title.trim() ? group.title : "Untitled group";
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/**
 * Hot temperature label. getHotPage receives useCelsius, so HotLinkDTO
 * temperatures are already in the reader's unit; only format here.
 */
export function formatTemperature(value: number): string {
  // PHP number_format rounds half away from zero.
  const rounded = Math.sign(value) * Math.round(Math.abs(value) * 10) / 10;
  return rounded.toFixed(1);
}

export function sortByTitle<T>(rows: T[], title: (row: T) => string): T[] {
  return [...rows].sort((a, b) => title(a).localeCompare(title(b), undefined, { sensitivity: "base", numeric: true }));
}

/** First alphabet character for the feeds jump strip. */
export function alphaKey(title: string): string {
  const first = title.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

export function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

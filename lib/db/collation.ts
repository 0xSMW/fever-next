import "server-only";
import { gunzipSync } from "node:zlib";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { normalizeUrl, legacyLower } from "../legacy-url";
import { DomainError } from "../validation";
import { UCA400_PRIMARY_DATA } from "./uca400-data";
import { phpStableSort } from "./php-sort";

/** Frozen MySQL 5.7 utf8_unicode_ci weights; no host-locale/ICU-version dependency. */
const primary = new Map<number, readonly number[]>();
const equivalentCharacters = new Map<string, string[]>();
for (const line of gunzipSync(Buffer.from(UCA400_PRIMARY_DATA, "base64")).toString("ascii").split("\n")) {
  const [point, encoded] = line.split(":");
  const codepoint = Number.parseInt(point, 16);
  const weights = encoded ? encoded.split(".").map(value => Number.parseInt(value, 16)) : [];
  primary.set(codepoint, weights);
  // PostgreSQL text cannot contain NUL; omit that unrepresentable source character.
  if (codepoint !== 0) {
    const key = weights.join(",");
    const characters = equivalentCharacters.get(key) ?? [];
    characters.push(String.fromCodePoint(codepoint));
    equivalentCharacters.set(key, characters);
  }
}

function weightsFor(codepoint: number): readonly number[] {
  const known = primary.get(codepoint);
  if (known) return known;
  // utf8mb3 source cannot represent supplementary characters. Keep new target
  // characters distinct, after BMP, rather than collapsing their group names.
  if (codepoint > 0xffff) return [0x10000, codepoint];
  const base = codepoint >= 0x3400 && codepoint <= 0x4db5 ? 0xfb80
    : codepoint >= 0x4e00 && codepoint <= 0x9fa5 ? 0xfb40 : 0xfbc0;
  return [base + (codepoint >> 15), (codepoint & 0x7fff) | 0x8000];
}

function primaryWeights(value: string): number[] {
  return Array.from(value).flatMap(character => [...weightsFor(character.codePointAt(0)!)]);
}

const SPACE_WEIGHT = weightsFor(0x20)[0];

/** PAD SPACE equality, including expansions/ignorable weights; never changes stored text. */
export function legacyTitleKey(value: string): string {
  const weights = primaryWeights(value);
  while (weights.at(-1) === SPACE_WEIGHT) weights.pop();
  return weights.join(",");
}

export function legacyTextEqual(left: string, right: string): boolean {
  return legacyTitleKey(left) === legacyTitleKey(right);
}

/** MySQL ASC: NULL first; a missing suffix compares as PAD SPACE, not a zero weight. */
export function legacyTextCompare(left: string | null, right: string | null): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  const a = primaryWeights(left), b = primaryWeights(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? SPACE_WEIGHT) - (b[index] ?? SPACE_WEIGHT);
    if (difference) return difference;
  }
  return 0;
}

function regexClass(character: string): string {
  const codepoint = character.codePointAt(0)!;
  // my_uca_charcmp compares one codepoint's complete weight sequence. It does
  // not expand the LIKE input or normalize composed/decomposed input strings.
  const weights = primary.get(codepoint);
  const equivalents = weights ? equivalentCharacters.get(weights.join(","))! : [character];
  return `[${equivalents.map(value => value.replace(/[\\\[\]\^-]/g, "\\$&")).join("")}]`;
}

/** Compile only LIKE atoms; user input cannot introduce regex syntax or nested repetition. */
export function legacyLikeRegex(pattern: string): string {
  if (pattern.length > 2050 || pattern.includes("\0")) throw new DomainError("The search pattern is too long or contains an unsupported character.");
  const characters = Array.from(pattern);
  let regex = "^";
  let afterMany = false;
  for (let index = 0; index < characters.length; index++) {
    let character = characters[index];
    if (afterMany && character === "\\") {
      if (index + 1 === characters.length) return "(?!)";
      // MySQL 5.7 my_wildcmp_uca_impl advances past this escape during
      // its post-% anchor scan, then recurses at the now-unescaped anchor.
      // Preserve both that literal anchor requirement and the recursive parse.
      regex += `(?=${regexClass(characters[++index])})`;
      character = characters[index];
      afterMany = false;
    }
    if (character === "%") {
      if (!regex.endsWith(".*")) regex += ".*";
      afterMany = true;
    } else if (character === "_") regex += ".";
    else if (character === "\\") {
      if (++index === characters.length) return "(?!)";
      regex += regexClass(characters[index]);
      afterMany = false;
    } else {
      regex += regexClass(character);
      afterMany = false;
    }
    if (Buffer.byteLength(regex, "utf8") > 131_072) throw new DomainError("The search pattern expands too far. Use a shorter search.");
  }
  return regex + "$";
}

/** Filtering/counting/pagination stay inside PostgreSQL; C avoids a second locale fold. */
export function legacyLike(column: SQLWrapper, pattern: string): SQL {
  return sql`(${column} COLLATE "C") ~ ${legacyLikeRegex(pattern)}`;
}

interface FeedTitle { id: number; title: string | null; customTitle?: string | null; url: string; }
function feedOrderKey(feed: FeedTitle): string {
  const title = feed.customTitle || feed.title;
  // PHP empty('0') is true. title() falls back to legacy normalize_url().
  return legacyLower(`${title && title !== "0" ? title : normalizeUrl(feed.url)}${feed.id}`);
}

/** Effective desktop/mobile feed order is PHP low(title(feed).id) + ksort, not SQL UCA. */
export function legacyFeedCompare(left: FeedTitle, right: FeedTitle): number {
  const a = feedOrderKey(left), b = feedOrderKey(right);
  const x = phpNumeric(a), y = phpNumeric(b);
  // PHP ksort SORT_REGULAR compares numeric strings numerically too, including
  // decimals/exponents that remain string array keys. Match PHP 8's overflow
  // fallback rather than relying on the host JavaScript locale or string sort.
  if (x && y) {
    if (x.integer !== undefined && y.integer !== undefined) return x.integer < y.integer ? -1 : x.integer > y.integer ? 1 : 0;
    if (x.integer !== undefined && y.overflow) return -y.overflow;
    if (y.integer !== undefined && x.overflow) return x.overflow;
    if (!(x.overflow && x.overflow === y.overflow && x.value === y.value) &&
        !(x.value === y.value && !Number.isFinite(x.value))) {
      return x.value < y.value ? -1 : x.value > y.value ? 1 : 0;
    }
  }
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Stable source PHP sorting is required for mixed numeric/non-numeric title keys. */
export function legacySortFeeds<T extends FeedTitle>(feeds: readonly T[]): T[] {
  return phpStableSort(feeds, legacyFeedCompare);
}

function phpNumeric(value: string): { integer?: bigint; value: number; overflow: number } | undefined {
  if (!/^[ \t\n\r\v\f]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?[ \t\n\r\v\f]*$/.test(value)) return undefined;
  const trimmed = value.trim();
  if (/^[+-]?[0-9]+$/.test(trimmed)) {
    const integer = BigInt(trimmed);
    if (integer >= -9_223_372_036_854_775_808n && integer <= 9_223_372_036_854_775_807n) return { integer, value: Number(integer), overflow: 0 };
    return { value: Number(trimmed), overflow: integer < 0 ? -1 : 1 };
  }
  return { value: Number(trimmed), overflow: 0 };
}

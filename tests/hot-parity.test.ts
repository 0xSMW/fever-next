import assert from "node:assert/strict";
import test from "node:test";
import { compileBlacklist, validateBlacklist, BlacklistValidationError } from "../lib/domain/blacklist";
import { hotTemperature, rankHotSnapshot, type HotOccurrence, type HotOptions } from "../lib/domain/hot";
import { extractLinkOccurrences, weightFeedLinks } from "../lib/ingest/links";
import { assertNoLegacyUrlCollisions, canonicalUrlKey, checksum, LegacyUrlCollisionError, normalizeUrl, resolveLegacyUrl, trueUrl } from "../lib/legacy-url";
import type { ItemDTO } from "../lib/contracts";

import { oracle, oracleProvenance, sourceHashes } from "./hot-oracle";

test("PHP oracle results record verified source hashes, harness and capture runtime", (t) => {
  const provenance = oracleProvenance();
  assert.deepEqual(provenance.sourceHashes, sourceHashes);
  assert.match(provenance.harnessSha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.phpVersion, /^8\./);
  assert.equal(provenance.timezone, "UTC");
  t.diagnostic(`${provenance.mode} PHP oracle; captured/runtime PHP ${provenance.phpVersion}, timezone=UTC`);
  assert.equal(oracle<unknown[]>("urls", { urls: [] }).length, 0);
});

test("URL normalization, wrapper tails, unsigned CRC32 and UTF-8 bytes match source PHP", () => {
  const urls = ["http://www.ShaunInman.com/a/Dir/index.php?arg=1", "https://shauninman.com/a/Dir/?arg=1", "http://www.com/etc", "http://LOCALHOST/index.php", "HTTPS://EXAMPLE.COM", "https://ÉXAMPLE.com/É/INDEX.html#Top", "https://x.com/a/index.phpBackup?A=1", "https://x.com/a/#Keep", "https://x.com/feeder/?seed=https%3A%2F%2Fdest.test%2Fa%2Bb&seed=https%3A%2F%2Fdest.test%2Ffinal%23frag", "https://x.com/rd?rd=&url=https%3A%2F%2Fother.test%2F", "https://x.com/rd?url=https%3A%2F%2Fdest.test%2Fa#fragment", "https://x.com/feeder/?seed=https%3A%2F%2Fx.com%2Frd%3Furl%3Dhttps%253A%252F%252Fdest.test%252F", "0", "", "123456789", "ไทย café"];
  const expected = oracle<Array<{ normalized: string; true: string; checksum: number }>>("urls", { urls });
  assert.deepEqual(urls.map((url) => ({ normalized: normalizeUrl(url), true: trueUrl(url), checksum: checksum(url) })), expected);
  assert.equal(checksum("123456789"), 3421780262);
});

test("Legacy relative URL resolver preserves filename, port, parent, and request-TLS quirks", () => {
  const pairs = [["https://site.test:8443/blog/article.php?x=1", "../portfolio/"], ["https://site.test/blog/article", "next"], ["https://site.test/blog/", "../../outside"], ["https://site.test/blog/article.php", "?q=1"], ["https://site.test/blog/", "/root"], ["https://site.test/blog/", "//cdn.test/a"], ["https://site.test/", "javascript:alert(1)"], ["http://site.test/a/b/c.php", "../x/../y"], ["http://site.test/a/", "./next"], ["http://site.test/a/", "https://other.test/x"]];
  for (const https of [false, true]) assert.deepEqual(pairs.map(([base, target]) => resolveLegacyUrl(base, target, https)), oracle("resolve", { pairs, https }));
});

test("Quoted anchors, duplicates, ignore rules, entity titles and raw item identities match PHP parse_links", () => {
  const item = { id: 7, feedId: 1, title: "Main &amp; title", url: "https://blog.test/post", publishedAt: 2_000_000_000, html: `<a href="https://other.test/story">A &amp; <b>bold</b><script>drop</script><style>drop</style></a><a href='https://other.test/story'>Duplicate</a><a href="../local">Local</a><a href="//cdn.test/story">CDN</a><a href="https://reddit.com/submit">terminal ignore retained</a><a href="https://reddit.com/submit?url=x">ignored</a><a href="#x">anchor</a><a href="mailto:a@b.test">mail</a><a href="/login-test">login</a><a href="https://">nowhere</a><a href="https://other.test/zero">0</a><a href="https://other.test/empty"><b></b></a><a href=https://other.test/unquoted>unquoted</a><a href="https://other.test/feeder/?seed=https%3A%2F%2Fdest.test%2Fstory"> redirect </a>` };
  const feed = { id: 1, siteUrl: "https://blog.test/dir/index.php", domain: "blog.test" };
  const blacklist = "https://other.test/story #dest\\.test#";
  const expected = oracle<Array<Record<string, unknown>>>("parse", { item: { id: item.id, title: item.title, link: item.url, description: item.html, created_on_time: item.publishedAt }, feed: { id: feed.id, site_url: feed.siteUrl, domain: feed.domain }, blacklist });
  const actual = extractLinkOccurrences(item, feed, compileBlacklist(blacklist));
  assert.deepEqual(actual.map((link) => ({ feed_id: link.feedId, item_id: link.itemId, is_blacklisted: Number(link.isBlacklisted), ...(link.isItem ? { is_item: 1 } : {}), is_local: Number(link.isLocal), title: link.title, url: link.url, url_checksum: String(link.urlChecksum), title_url_checksum: String(link.titleUrlChecksum), created_on_time: link.createdAt })), expected);
  assert.equal(actual.filter((link) => link.url === "https://other.test/story").length, 2);
  assert.ok(actual.every((link) => link.urlKey === canonicalUrlKey(link.canonicalUrl) && link.normalizationVersion === 1 && link.rankingVersion === 1));
});

test("Blacklist legacy exact/regex matching agrees with PHP; unsupported PCRE is visible and bounded", () => {
  const urls = ["https://example.test/A", "HTTPS://EXAMPLE.TEST/a", "https://example.test/A\n", "https://example.test/A?x=1", "https://other.test/path", "https://cdn.test/ads/x", "https://cdn.test/ad/x"];
  for (const blacklist of ["", "0", "https://example.test/A", "#ads/|other\\.test#", "#example#i", "https://other.test/path\t#ads/#\n0"]) {
    assert.deepEqual(urls.map((url) => compileBlacklist(blacklist).matches(url)), oracle("blacklist", { blacklist, urls }), blacklist);
  }
  const unsupported = compileBlacklist("#(?<=private)/#");
  assert.equal(unsupported.issues.length, 1);
  assert.equal(unsupported.rules[0].enabled, false);
  assert.equal(unsupported.matches("private/"), false);
  assert.throws(() => validateBlacklist("#(?<=private)/#"), BlacklistValidationError);
  const domains = compileBlacklist("domain:Example.test");
  assert.deepEqual(["https://example.test/", "https://a.example.test/", "https://notexample.test/", "https://example.test.evil/"].map((url) => domains.matches(url)), [true, true, false, false]);
  assert.throws(() => domains.matches("x".repeat(65537)), RangeError);
});

function occurrence(id: number, canonicalUrl: string, overrides: Partial<HotOccurrence> = {}): HotOccurrence {
  return { id, feedId: id, itemId: id, url: `https://${canonicalUrl}`, canonicalUrl, urlKey: canonicalUrlKey(canonicalUrl), urlChecksum: checksum(canonicalUrl), title: `Title ${id}`, createdAt: 2_000_000_000 - id * 100, isItem: false, isLocal: false, isFirst: true, isBlacklisted: false, weight: 0, ...overrides };
}
function item(link: HotOccurrence, overrides: Partial<ItemDTO> = {}): ItemDTO {
  return { id: link.itemId, feedId: link.feedId, title: `Item ${link.itemId}`, author: "", url: link.url, html: `<p>Article ${link.itemId}</p>`, excerpt: "Article", publishedAt: link.createdAt, addedAt: link.createdAt, readAt: 0, isSaved: false, isNew: false, feedTitle: "Fixture", faviconId: 1, ...overrides };
}
function phpLink(link: HotOccurrence) {
  return { id: link.id, feed_id: link.feedId, item_id: link.itemId, url: link.url, url_checksum: link.urlChecksum, title: link.title, created_on_time: link.createdAt, is_item: Number(link.isItem), is_local: Number(link.isLocal), is_first: Number(link.isFirst), is_blacklisted: Number(link.isBlacklisted), weight: link.weight };
}
function assertRankParity(links: HotOccurrence[], items: ItemDTO[], options: HotOptions = {}, now = 2_000_000_000) {
  const expected = oracle<Array<Record<string, unknown>>>("rank", { rows: links.map(phpLink), items: items.map((i) => ({ id: i.id, title: i.title, link: i.url, description: i.html, created_on_time: i.publishedAt, is_saved: Number(i.isSaved) })), options, celsius: options.useCelsius ?? false, now });
  const actual = rankHotSnapshot({ occurrences: links, items }, options, now);
  assert.deepEqual(actual.links.map((l) => ({ id: l.id, feed_id: l.feedId, item_id: l.itemId, url: l.url, title: l.title, description: l.html, is_item: Number(l.isItem), is_local: Number(l.isLocal), is_saved: Number(l.isSaved), item_ids: l.itemIds, temperature: l.temperature })), expected.map((l) => ({ id: l.id, feed_id: l.feed_id, item_id: l.item_id, url: l.url, title: l.title, description: l.description, is_item: l.is_item, is_local: l.is_local, is_saved: l.is_saved, item_ids: l.item_ids, temperature: l.temperature })));
  return actual;
}

test("Per-feed weighting keeps first/repeat penalties and retention survivor promotion matching PHP", () => {
  const links = [occurrence(1, "site.test/a", { feedId: 1, isLocal: true, createdAt: 100 }), occurrence(2, "site.test/a", { feedId: 1, isItem: true, createdAt: 200 }), occurrence(3, "site.test/b", { feedId: 1, isItem: true, createdAt: 300 }), occurrence(4, "feeds.feedburner.com/x", { feedId: 1, createdAt: 400 }), occurrence(5, "site.test/a", { feedId: 1, createdAt: 500 })];
  for (const retained of [links, links.slice(1)]) {
    const expected = oracle<Array<{ id: number; weight: number; is_first: number }>>("weights", { rows: retained.map(phpLink) });
    assert.deepEqual(weightFeedLinks(retained).map((l) => [l.id, l.weight, Number(l.isFirst)]), expected.map((l) => [l.id, l.weight, l.is_first]));
  }
  const separateFeed = weightFeedLinks([links[0], { ...links[1], feedId: 2 }]);
  assert.deepEqual(separateFeed.map((l) => [l.weight, l.isFirst]), [[1, true], [0, true]]);
});

test("Hot scoring uses strict edges, first flags, blacklist and limit before the >1.25 threshold", () => {
  const now = 2_000_000_000; const end = now - 7 * 86400;
  const links = [occurrence(1, "story.test/hot"), occurrence(2, "story.test/hot"), occurrence(3, "story.test/cold"), occurrence(4, "story.test/blacklisted", { isBlacklisted: true }), occurrence(5, "story.test/blacklisted", { isBlacklisted: true }), occurrence(6, "story.test/hot", { isFirst: false }), occurrence(7, "story.test/edge", { createdAt: end }), occurrence(8, "story.test/future", { createdAt: now + 10 }), occurrence(9, "story.test/future", { createdAt: now + 20 }), occurrence(10, "story.test/hot")];
  const items = links.map((l) => item(l));
  const page = assertRankParity(links, items, { perPage: 1 }, now);
  assert.equal(page.totalCandidates, 3);
  assert.equal(page.links.length, 1);
  assertRankParity(links, items, { page: 3, perPage: 1 }, now);
  const cold = rankHotSnapshot({ occurrences: links, items }, { page: 3, perPage: 1 }, now);
  assert.equal(cold.totalCandidates, 3); assert.deepEqual(cold.links, []);
  assertRankParity(links, items, { offset: 1, range: 6 }, now);
});

test("Hot representative prefers item/local/older, retrieves old blacklisted originals and filters source times", () => {
  const now = 2_000_000_000;
  const links = [occurrence(1, "story.test/shared"), occurrence(2, "story.test/shared", { isItem: true, title: "Remote article" }), occurrence(3, "story.test/shared", { isItem: true, isLocal: true, isBlacklisted: true, createdAt: now - 30 * 86400, title: "Old original occurrence" }), occurrence(4, "story.test/shared", { isItem: true, isLocal: true, isFirst: false, createdAt: now - 20 * 86400, title: "Newer local" })];
  const items = links.map((l) => item(l, { title: `Edited item ${l.id}`, isSaved: l.id === 3, html: l.id === 3 ? '  <p>Original content</p><div><a title="Permanent link to original">permalink</a></div>  ' : "<p>Other</p>" }));
  const page = assertRankParity(links, items);
  assert.equal(page.links[0].id, 3);
  assert.equal(page.links[0].title, "Old original occurrence");
  assert.equal(page.links[0].html, "<p>Original content</p>");
  assert.equal(page.links[0].isSaved, true);
  assert.deepEqual(page.links[0].itemIds, [1, 2]);
  assert.equal(page.links[0].sources.length, 2);
});

test("Offset windows exclude both exact scoring edges while source item filtering includes endpoints", () => {
  const now = 2_000_000_000; const start = now - 86400; const end = start - 7 * 86400;
  const links = [occurrence(1, "within.test/a", { createdAt: start - 1 }), occurrence(2, "within.test/a", { createdAt: end + 1 }), occurrence(3, "start.test/a", { createdAt: start }), occurrence(4, "start.test/a", { createdAt: start }), occurrence(5, "end.test/a", { createdAt: end }), occurrence(6, "end.test/a", { createdAt: end })];
  const items = links.map((l) => item(l, { publishedAt: l.id === 1 ? start : l.id === 2 ? end : l.createdAt }));
  const page = assertRankParity(links, items, { offset: 1, range: 7 }, now);
  assert.equal(page.totalCandidates, 1);
  assert.deepEqual(page.links[0].itemIds, [1, 2]);
});

test("Hot title frequency, word matching, numeric tokens and entity eligibility match PHP", () => {
  const cases = [["Repeated", "repeated", "noise"], ["[link]", "#", "unrelated"], ["other words", "shared article", "x"], ["123 456", "other", "noise"], ["&#x1F600;", "&#0;", "&apos;"], ["&copy;", "&amp;", "&NotEqualTilde;"]];
  for (const titles of cases) {
    const links = titles.map((title, i) => occurrence(i + 1, "story.test/shared-article", { title }));
    assertRankParity(links, links.map((l) => item(l, { title: l.id === 3 ? "Last backing" : `Item ${l.id}` })));
  }
});

test("PHP one-decimal temperature rounding agrees at half ties and for all realistic weighted scores", () => {
  const scores = [0, 1.25, 1.875, 2.5, 3.75, 10, 0.1, 0.2, 0.3, -98.6, -97.4, ...Array.from({ length: 161 }, (_, n) => n * 0.625), ...Array.from({ length: 20 }, (_, n) => 1.25 + 1.25 / 2 ** n)];
  for (const celsius of [false, true]) assert.deepEqual(scores.map((score) => hotTemperature(score, celsius)), oracle("temperature", { scores, celsius }));
});

test("Same rounded temperature prioritizes local articles while checksum/time ties are deterministic", () => {
  const links = [occurrence(1, "a.test/article", { isItem: false }), occurrence(2, "a.test/article", { weight: 8 }), occurrence(3, "b.test/article", { isItem: true, isLocal: true }), occurrence(4, "b.test/article", { weight: 9 })];
  const page = assertRankParity(links, links.map((l) => item(l)));
  assert.equal(page.links[0].isLocal, true);
  const ties = [occurrence(20, "tie.test/x", { createdAt: 100, feedId: 1 }), occurrence(10, "tie.test/x", { createdAt: 100, feedId: 1 })];
  assert.deepEqual(weightFeedLinks(ties).map((l) => [l.id, l.isFirst]), [[10, true], [20, false]]);
  const scoreTies = [occurrence(11, "first.test/a"), occurrence(12, "first.test/a"), occurrence(13, "second.test/a"), occurrence(14, "second.test/a")];
  const tiedPage = rankHotSnapshot({ occurrences: scoreTies, items: scoreTies.map((l) => item(l)) }, {}, 2_000_000_000);
  assert.deepEqual(tiedPage.links.map((l) => checksum(normalizeUrl(l.url))), [checksum("first.test/a"), checksum("second.test/a")].sort((a, b) => a - b));
});

test("CRC/digest collisions are reported instead of merging article identity", () => {
  assert.throws(() => assertNoLegacyUrlCollisions([{ canonicalUrl: "a.test/a", legacyUrlChecksum: 1 }, { canonicalUrl: "b.test/b", legacyUrlChecksum: 1 }]), LegacyUrlCollisionError);
  assert.throws(() => assertNoLegacyUrlCollisions([{ canonicalUrl: "a.test/a", canonicalKey: "same", legacyUrlChecksum: 1 }, { canonicalUrl: "b.test/b", canonicalKey: "same", legacyUrlChecksum: 2 }]), /digest collision/);
  const a = occurrence(1, "a.test/a"); const b = occurrence(2, "b.test/b", { urlChecksum: a.urlChecksum });
  assert.throws(() => rankHotSnapshot({ occurrences: [a, b], items: [item(a), item(b)] }, {}, 2_000_000_000), LegacyUrlCollisionError);
  assert.throws(() => weightFeedLinks([a, b]), LegacyUrlCollisionError);
});

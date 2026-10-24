import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { closeDatabase } from "../lib/db/client";
import { getHotPage, rankHotSnapshot, type HotOccurrence, type HotOptions } from "../lib/domain/hot";
import { saveBlacklist, reapplyBlacklist } from "../lib/domain/blacklist";
import { weightFeedLinks } from "../lib/ingest/links";
import { canonicalUrlKey, checksum, LegacyUrlCollisionError, normalizeUrl } from "../lib/legacy-url";
import { sanitizeContent } from "../lib/ingest/content";
import { verifierForFeverDigest } from "../lib/auth/fever";
import { getAuthRuntime } from "../lib/auth/runtime";
import { handleFever } from "../lib/compat/fever";
import type { HotLinkDTO, ItemDTO } from "../lib/contracts";
import { connectRehearsal, hotEnabled, receipt } from "./hot-rehearsal";
import { legacyManifest, mysqlOracle, oracle } from "./hot-oracle";

const now = 2_000_000_000;
const owner = { id: 1, email: "hot-parity-20261024@example.test" };
const digest = createHash("md5").update("isolated hot fixture credential").digest("hex");
type LegacyLink = { id: number | string; feed_id: number | string; item_id: number | string; url: string; title: string; description: string; is_item: number | string; is_local: number | string; is_saved: number; item_ids: Array<number | string>; temperature: number };
type MysqlResult = { result: LegacyLink[]; scores: Array<{ url_checksum: number | string; weight: number | string }>; queries: Array<{ sql: string; ids: Array<number | string> }> };

function fixture() {
  const links: HotOccurrence[] = [];
  const add = (canonicalUrl: string, overrides: Partial<HotOccurrence> = {}) => {
    const id = links.length + 1;
    const link: HotOccurrence = { id, feedId: id, itemId: id, url: `https://${canonicalUrl}`, canonicalUrl,
      urlKey: canonicalUrlKey(canonicalUrl), urlChecksum: checksum(canonicalUrl), title: `Anchor ${id}`,
      createdAt: now - id * 100, isItem: false, isLocal: false, isFirst: false, isBlacklisted: false, weight: 0, ...overrides };
    links.push(link); return link;
  };
  add("news.test/shared", { title: "Repeated story" });
  add("news.test/shared", { title: "repeated story" });
  add("news.test/shared", { isItem: true, title: "Remote item" });
  add("news.test/shared", { isItem: true, isLocal: true, isBlacklisted: true, createdAt: now - 30 * 86400, title: "Old original" });
  add("news.test/shared", { feedId: 1, title: "Duplicate in first feed" });
  add("news.test/cold");
  add("local.test/penalty", { isLocal: true });
  add("local.test/penalty");
  add("local.test/penalty");
  add("feeds.feedburner.com/penalty");
  add("feeds.feedburner.com/penalty");
  add("feeds.feedburner.com/penalty");
  add("future.test/imported", { createdAt: now + 1 });
  add("future.test/imported", { createdAt: now + 2 });
  add("boundary.test/end", { createdAt: now - 7 * 86400 });
  add("boundary.test/end", { createdAt: now - 7 * 86400 });
  add("boundary.test/start", { createdAt: now - 86400 });
  add("boundary.test/start", { createdAt: now - 86400 });
  add("within.test/offset", { createdAt: now - 86400 - 1 });
  add("within.test/offset", { createdAt: now - 7 * 86400 + 1 });
  add("title.test/shared-article", { title: "&#x1F600;" });
  add("title.test/shared-article", { title: "shared article" });
  add("title.test/shared-article", { title: "123 456" });
  add("retention.test/promoted", { createdAt: now - 80 * 86400, feedId: 24 });
  add("retention.test/promoted", { createdAt: now - 500, feedId: 24 });
  add("retention.test/promoted", { createdAt: now - 600 });
  add("rounded.test/local", { isItem: true, isLocal: true });
  add("rounded.test/local", { isLocal: true });
  add("rounded.test/remote");
  add("rounded.test/remote", { isLocal: true });
  add("news.test/shared", { title: "One more independent citation" });
  add("numeric.test/high", { id: 4_000_000_000, feedId: 4_000_000_000, itemId: 4_000_000_000, isItem: true, isLocal: true, createdAt: 4_000_000_000 });
  add("numeric.test/high");
  const weighted = weightFeedLinks(links);
  const items: ItemDTO[] = weighted.map((l, index) => ({ id: l.itemId, feedId: l.feedId, title: `Backing ${l.itemId}`, author: "Fixture author", url: l.url,
    html: `<p>Article ${l.itemId}</p>`, excerpt: `Article ${l.itemId}`, publishedAt: l.createdAt, addedAt: now - index - 1, readAt: l.id % 2 ? 0 : now - 1,
    isSaved: l.id === 4 || l.id === 24, isNew: l.id % 2 === 1 && l.id !== 24, feedTitle: `Feed ${l.feedId}`, faviconId: 1 }));
  return { links: weighted, items };
}
function legacyApi(link: LegacyLink) {
  return { id: Number(link.id), feed_id: Number(link.feed_id), item_id: Number(link.item_id), temperature: link.temperature,
    is_item: Number(link.is_item), is_local: Number(link.is_local), is_saved: Number(link.is_saved), title: link.title, url: link.url, item_ids: link.item_ids.map(Number).join(",") };
}
function modernApi(link: HotLinkDTO) {
  return { id: link.id, feed_id: link.feedId, item_id: link.itemId, temperature: link.temperature, is_item: Number(link.isItem),
    is_local: Number(link.isLocal), is_saved: Number(link.isSaved), title: link.title, url: link.url, item_ids: link.itemIds.join(",") };
}
function byId<T extends { id: number }>(rows: T[]) { return [...rows].sort((a, b) => a.id - b.id); }

test("Actual MySQL/PHP and PostgreSQL Hot phases, sources, blacklist, retention, and Fever objects", { skip: !hotEnabled, timeout: 600_000 }, async (t) => {
  const { source, operator, pool, identity } = await connectRehearsal();
  const socket = process.env.FEVER_MYSQL_SOCKET!;
  const manifest = legacyManifest();
  const frozen = fixture();
  let links = frozen.links;
  let items = frozen.items;
  let owned = false;
  const phases: Record<string, unknown>[] = [];
  const ties: Record<string, unknown>[] = [];
  try {
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM owner")).rows[0].count, 0, "Refusing a nonempty Hot destination");
    assert.equal((await pool.query("SELECT status FROM installation WHERE id=1")).rows[0].status, "uninitialized");
    for (const table of ["feeds", "items", "links"]) {
      await source.query(`CREATE TABLE IF NOT EXISTS \`${table}\` ${manifest[table]} ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
      assert.equal(Number((await source.query<RowDataPacket[]>(`SELECT count(*) AS count FROM \`${table}\``))[0][0].count), 0, "Refusing preexisting source fixture rows");
    }
    await pool.query("INSERT INTO owner(id,email,email_key,password_hash) VALUES(1,$1::text,$1::text,'synthetic-hot-only')", [owner.email]); owned = true;
    await pool.query("INSERT INTO reader_preferences(owner_id,per_page,item_allows) VALUES(1,200,2)");
    await pool.query("INSERT INTO reader_view_state(owner_id,device_id,last_session_at) VALUES(1,'default',0)");
    await pool.query("INSERT INTO fever_credentials(owner_id,verifier) VALUES(1,$1)", [verifierForFeverDigest(digest)]);
    await pool.query("UPDATE installation SET status='ready' WHERE id=1");
    const feedIds = [...new Set(links.map((l) => l.feedId))];
    for (const feedId of feedIds) {
      const url = `https://feeds.test/${feedId}`; const canonical = normalizeUrl(url);
      await source.execute("INSERT INTO feeds(id,title,url,url_checksum,site_url,domain,is_spark) VALUES(?,?,?,?,?,?,?)", [feedId, `Feed ${feedId}`, url, checksum(canonical), "https://feeds.test/", "feeds.test", Number(feedId === 2)]);
      await pool.query("INSERT INTO feeds(id,owner_id,title,url,original_url,canonical_url,url_key,url_checksum,site_url,domain,is_spark,item_allows) VALUES($1,1,$2,$3,$3,$4,$5,$6,'https://feeds.test/','feeds.test',$7,2)", [feedId, `Feed ${feedId}`, url, canonical, canonicalUrlKey(canonical), checksum(canonical), feedId === 2]);
    }
    for (const i of items) {
      await source.execute("INSERT INTO items(id,feed_id,uid,title,author,description,link,url_checksum,read_on_time,is_saved,created_on_time,added_on_time) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [i.id, i.feedId, `fixture-${i.id}`, i.title, i.author, i.html, i.url, checksum(normalizeUrl(i.url)), i.readAt, Number(i.isSaved), i.publishedAt, i.addedAt]);
      await pool.query("INSERT INTO items(id,feed_id,identity_key,title,author,raw_html,html,url,canonical_url,url_checksum,published_at,added_at,read_at,is_saved) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13)", [i.id, i.feedId, canonicalUrlKey(`item-${i.id}`), i.title, i.author, i.html, i.url, normalizeUrl(i.url), checksum(normalizeUrl(i.url)), i.publishedAt, i.addedAt, i.readAt, i.isSaved]);
    }
    for (const l of links) {
      await source.execute("INSERT INTO links(id,feed_id,item_id,is_blacklisted,is_item,is_local,is_first,title,url,url_checksum,title_url_checksum,weight,created_on_time) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [l.id, l.feedId, l.itemId, Number(l.isBlacklisted), Number(l.isItem), Number(l.isLocal), Number(l.isFirst), l.title, l.url, l.urlChecksum, checksum(l.title + l.canonicalUrl), l.weight, l.createdAt]);
      await pool.query("INSERT INTO link_occurrences(id,feed_id,item_id,original_url,url,canonical_url,url_key,url_checksum,title_url_checksum,title,is_item,is_local,is_blacklisted,is_first,weight,created_at) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [l.id, l.feedId, l.itemId, l.url, l.canonicalUrl, l.urlKey, l.urlChecksum, checksum(l.title + l.canonicalUrl), l.title, l.isItem, l.isLocal, l.isBlacklisted, l.isFirst, l.weight, l.createdAt]);
    }
    const sourceWeights = mysqlOracle<{ result: Array<{ id: number; weight: number; is_first: number }> }>("weights", { socket, feedIds }).result;
    assert.deepEqual(sourceWeights.map((l) => [Number(l.id), Number(l.weight), Number(l.is_first)]), [...links].sort((a, b) => a.id - b.id).map((l) => [l.id, l.weight, Number(l.isFirst)]));
    phases.push({ phase: "per-feed-weights", rows: sourceWeights });

    const compare = async (label: string, options: HotOptions = {}) => {
      const expected = mysqlOracle<MysqlResult>("rank", { socket, now, options, celsius: options.useCelsius ?? false });
      const clock = t.mock.method(Date, "now", () => now * 1000);
      let actual;
      try { actual = await getHotPage(owner, options); }
      finally { clock.mock.restore(); }
      const pure = rankHotSnapshot({ occurrences: links, items }, options, now);
      assert.deepEqual(actual, pure, `${label}: actual PostgreSQL reader DTO differs from pure pipeline`);
      const expectedApi = expected.result.map(legacyApi); const actualApi = actual.links.map(modernApi);
      assert.deepEqual(byId(actualApi), byId(expectedApi), `${label}: source PHP/MySQL fields differ`);
      const sourceIds = expectedApi.map((l) => l.id), targetIds = actualApi.map((l) => l.id);
      if (JSON.stringify(sourceIds) !== JSON.stringify(targetIds)) {
        const scoreById = new Map(actual.links.map((l) => [l.id, Number(expected.scores.find((s) => Number(s.url_checksum) === checksum(normalizeUrl(l.url)))?.weight)]));
        for (let i = 0; i < actual.links.length; i++) if (sourceIds[i] !== targetIds[i]) assert.equal(scoreById.get(sourceIds[i]), scoreById.get(targetIds[i]), `${label}: order differs beyond exact score ties`);
        ties.push({ label, sourceIds, targetIds, disposition: "Source ORDER BY score has no equal-score tie breaker; target checksum ASC is specified deterministic adaptation." });
      }
      for (const target of actual.links) {
        const original = expected.result.find((l) => Number(l.id) === target.id)!;
        assert.equal(target.html, sanitizeContent(original.description, "rich", target.url), `${label}: local description`);
      }
      const windowStart = now - (options.offset ?? 0) * 86400; const windowEnd = windowStart - (options.range ?? 7) * 86400;
      const sourceSql = readFileSync(new URL("../lib/domain/hot.ts", import.meta.url), "utf8").split("const scored =")[1].match(/`([^`]+)`/)![1];
      const pgCandidates = (await pool.query(sourceSql, [1, windowEnd, (options.offset ?? 0) === 0, windowStart, options.perPage ?? 200, ((options.page ?? 1) - 1) * (options.perPage ?? 200)])).rows;
      const sourceCandidates = expected.scores.filter((s) => Number(s.weight) > 1.25).map((s) => ({ url_checksum: Number(s.url_checksum), score: Number(s.weight) }));
      assert.deepEqual([...pgCandidates].map((s) => ({ url_checksum: Number(s.url_checksum), score: Number(s.score) })).sort((a, b) => a.url_checksum - b.url_checksum), sourceCandidates.sort((a, b) => a.url_checksum - b.url_checksum), `${label}: SQL aggregate candidates`);
      phases.push({ phase: label, options, sourceScores: expected.scores, postgresCandidates: pgCandidates, sourceQueries: expected.queries, sourceLinks: expectedApi, postgresLinks: actualApi, readerLinks: actual.links, totalCandidates: actual.totalCandidates });
      return actual;
    };
    await compare("now-fahrenheit", { perPage: 200 });
    await compare("now-celsius", { perPage: 200, useCelsius: true });
    await compare("offset-strict-edges", { perPage: 200, offset: 1, range: 6 });
    // Page 2 starts after the single 3.75 score; page at the cold tail validates
    // limit-before-threshold without treating unspecified score ties as stable.
    await compare("first-page", { perPage: 1 });
    const all = rankHotSnapshot({ occurrences: links, items }, { perPage: 200 }, now);
    await compare("cold-tail-page", { perPage: 1, page: all.totalCandidates });
    await t.test("Fever handler links use actual PostgreSQL pipeline and numeric/CSV contract", async () => {
      const clock = t.mock.method(Date, "now", () => now * 1000);
      let expected, response;
      try {
        expected = (await getHotPage(owner, { perPage: 200 })).links.map(modernApi);
        response = await handleFever(new Request(`${getAuthRuntime().baseUrl}/?api&links`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ api_key: digest }) }));
      } finally { clock.mock.restore(); }
      assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.auth, 1);
      assert.equal(result.use_celsius, 0); assert.deepEqual(result.links, expected);
      phases.push({ phase: "actual-fever-handler", response: result });
    });
    // Source fetch_feed() deletes the old item's occurrences before replacing
    // them; preserve article identity/time/read/save while changing its link.
    const previous = links.find((l) => l.id === 31)!;
    const replacementUrl = "https://replacement.test/story", replacementCanonical = normalizeUrl(replacementUrl);
    const replacement = { ...previous, id: 100, url: replacementUrl, canonicalUrl: replacementCanonical, urlKey: canonicalUrlKey(replacementCanonical), urlChecksum: checksum(replacementCanonical), title: "Replacement occurrence", isItem: true };
    const articleBefore = (await pool.query("SELECT published_at,added_at,read_at,is_saved FROM items WHERE id=31")).rows[0];
    await source.execute("DELETE FROM links WHERE item_id=31");
    await pool.query("DELETE FROM link_occurrences WHERE item_id=31");
    await source.execute("UPDATE items SET link=?,url_checksum=? WHERE id=31", [replacementUrl, replacement.urlChecksum]);
    await pool.query("UPDATE items SET url=$1,canonical_url=$2,url_checksum=$3 WHERE id=31", [replacementUrl, replacementCanonical, replacement.urlChecksum]);
    await source.execute("INSERT INTO links(id,feed_id,item_id,is_item,is_local,is_first,title,url,url_checksum,title_url_checksum,weight,created_on_time) VALUES(100,31,31,1,0,1,?,?,?,?,0,?)", [replacement.title, replacement.url, replacement.urlChecksum, checksum(replacement.title + replacementCanonical), replacement.createdAt]);
    await pool.query("INSERT INTO link_occurrences(id,feed_id,item_id,original_url,url,canonical_url,url_key,url_checksum,title_url_checksum,title,is_item,is_local,is_first,weight,created_at) VALUES(100,31,31,$1,$1,$2,$3,$4,$5,$6,true,false,true,0,$7)", [replacement.url, replacementCanonical, replacement.urlKey, replacement.urlChecksum, checksum(replacement.title + replacementCanonical), replacement.title, replacement.createdAt]);
    links = weightFeedLinks(links.map((l) => l.id === previous.id ? replacement : l));
    items = items.map((i) => i.id === 31 ? { ...i, url: replacementUrl } : i);
    assert.deepEqual((await pool.query("SELECT published_at,added_at,read_at,is_saved FROM items WHERE id=31")).rows[0], articleBefore);
    await compare("updated-item-link-replacement", { perPage: 200 });
    await t.test("PostgreSQL reports a CRC collision even for a cold imported occurrence", async () => {
      await pool.query("UPDATE link_occurrences SET url_checksum=$1 WHERE id=100", [checksum("news.test/shared")]);
      try { await assert.rejects(getHotPage(owner), LegacyUrlCollisionError); }
      finally { await pool.query("UPDATE link_occurrences SET url_checksum=$1 WHERE id=100", [replacement.urlChecksum]); }
      phases.push({ phase: "collision-guard", disposition: "Source CRC merge is intentionally rejected per migration collision requirement", reported: true });
    });
    const blacklist = "https://local.test/penalty #title\\.test/# domain:future.test";
    const legacyBlacklist = "https://local.test/penalty #title\\.test/|^https?://([^/]+\\.)?future\\.test/#";
    await saveBlacklist(owner, blacklist);
    const sourceRows = (await source.query<RowDataPacket[]>("SELECT id,url FROM links ORDER BY id"))[0];
    const flags = oracle<boolean[]>("blacklist", { blacklist: legacyBlacklist, urls: sourceRows.map((r) => r.url) });
    for (let i = 0; i < sourceRows.length; i++) await source.execute("UPDATE links SET is_blacklisted=? WHERE id=?", [Number(flags[i]), sourceRows[i].id]);
    links = links.map((l) => ({ ...l, isBlacklisted: flags[sourceRows.findIndex((r) => Number(r.id) === l.id)] }));
    assert.equal((await reapplyBlacklist(owner)).matched, flags.filter(Boolean).length);
    await compare("blacklist-recomputed", { perPage: 200 });
    await t.test("cancelling blacklist recomputation rolls back existing flags and preferences", async () => {
      const before = (await pool.query("SELECT blacklist,version FROM reader_preferences WHERE owner_id=1")).rows;
      const beforeFlags = (await pool.query("SELECT id,is_blacklisted FROM link_occurrences ORDER BY id")).rows;
      const controller = new AbortController();
      await assert.rejects(saveBlacklist(owner, "#news\\.test/#", { signal: controller.signal, onProgress: () => controller.abort(new Error("fixture cancellation")) }), /fixture cancellation/);
      assert.deepEqual((await pool.query("SELECT blacklist,version FROM reader_preferences WHERE owner_id=1")).rows, before);
      assert.deepEqual((await pool.query("SELECT id,is_blacklisted FROM link_occurrences ORDER BY id")).rows, beforeFlags);
      phases.push({ phase: "blacklist-cancellation", rolledBackPreferencesAndFlags: true });
    });
    const expiry = now - 70 * 86400;
    await source.execute("DELETE FROM links WHERE created_on_time < ?", [expiry]);
    await source.execute("DELETE FROM items WHERE created_on_time < ? AND is_saved=0", [expiry]);
    await pool.query("DELETE FROM link_occurrences WHERE created_at < $1", [expiry]);
    await pool.query("DELETE FROM items WHERE published_at < $1 AND NOT is_saved", [expiry]);
    links = weightFeedLinks(links.filter((l) => l.createdAt >= expiry));
    items = items.filter((i) => i.publishedAt >= expiry || i.isSaved);
    mysqlOracle("weights", { socket, feedIds });
    for (const l of links) await pool.query("UPDATE link_occurrences SET weight=$2,is_first=$3 WHERE id=$1", [l.id, l.weight, l.isFirst]);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM items WHERE id=24 AND is_saved")).rows[0].count, 1);
    assert.equal(links.find((l) => l.id === 25)?.isFirst, true);
    await compare("expired-first-survivor-promoted", { perPage: 200 });
    receipt("hot-cross-engine.json", { recordedAt: new Date().toISOString(), frozenNow: now, source: { php: "8.5.10", mysql: "5.7.24", engine: "MyISAM", collation: "utf8_unicode_ci", harness: "Verbatim extracted PHP methods, frozen time injection, PDO executes original source queries" }, target: identity, initialDataset: frozen, phases, acceptedTies: ties, unexplainedDifferences: 0 });
  } finally {
    if (owned) {
      await pool.query("DELETE FROM owner WHERE id=1 AND email=$1", [owner.email]);
      await pool.query("UPDATE installation SET status='uninitialized' WHERE id=1");
      const rateSubject = createHmac("sha256", getAuthRuntime().secret).update("fever-auth-rate-v1\0fever").digest("hex");
      await pool.query("DELETE FROM auth_rate_limits WHERE subject_hash=$1", [rateSubject]);
      // All source rows were created by this exact fixture after empty checks.
      for (const table of ["links", "items", "feeds"]) await source.query(`DELETE FROM \`${table}\``);
      const sourceCounts: Record<string, number> = {};
      for (const table of ["links", "items", "feeds"]) sourceCounts[table] = Number((await source.query<RowDataPacket[]>(`SELECT count(*) AS count FROM \`${table}\``))[0][0].count);
      assert.deepEqual(sourceCounts, { links: 0, items: 0, feeds: 0 });
      const targetCounts = (await pool.query("SELECT (SELECT count(*) FROM owner)::int AS owner,(SELECT count(*) FROM feeds)::int AS feeds,(SELECT count(*) FROM items)::int AS items,(SELECT count(*) FROM link_occurrences)::int AS links,(SELECT count(*) FROM auth_rate_limits)::int AS rate_limits")).rows[0];
      assert.deepEqual(targetCounts, { owner: 0, feeds: 0, items: 0, links: 0, rate_limits: 0 });
      receipt("cleanup.json", { targetCounts, sourceDatabase: "fever_hot_parity_20261024", sourceCounts });
    }
    await source.end(); await operator.end(); await closeDatabase();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { closeDatabase } from "../lib/db/client";
import { connectRehearsal, hotEnabled, receipt } from "./hot-rehearsal";
import { oracle } from "./hot-oracle";
import { legacySortFeeds, legacyLikeRegex, legacyTextCompare, legacyTextEqual } from "../lib/db/collation";

/** These are characterizations, not permission to accept changed search results. */
test("MySQL 5.7 source vs PostgreSQL search, ordering, NULL, and title collisions", { skip: !hotEnabled, timeout: 120_000 }, async () => {
  const { source, operator, identity } = await connectRehearsal();
  const corpus: Array<{ id: number; title: string | null; url: string; description: string | null }> = [
    { id: 1, title: "Alpha", url: "https://example.test/A", description: "plain" },
    { id: 2, title: "alpha", url: "https://example.test/B", description: "case" },
    { id: 3, title: "café", url: "https://example.test/cafe", description: "accent" },
    { id: 4, title: "cafe", url: "https://example.test/other", description: "plain" },
    { id: 5, title: "CAFÉ", url: "https://example.test/upper", description: "plain" },
    { id: 6, title: "Straße", url: "https://example.test/strasse", description: "sharp" },
    { id: 7, title: "STRASSE", url: "https://example.test/other7", description: "plain" },
    { id: 8, title: "Ångström", url: "https://example.test/unicode", description: "plain" },
    { id: 9, title: "angstrom", url: "https://example.test/other9", description: "plain" },
    { id: 10, title: "ไทย", url: "https://example.test/thai", description: "ไทยทดสอบ" },
    { id: 11, title: "100% _value", url: "https://example.test/percent", description: "back\\slash" },
    { id: 12, title: "100x avalue", url: "https://example.test/other12", description: "plain" },
    { id: 13, title: "é", url: "https://example.test/composed", description: "plain" },
    { id: 14, title: "e\u0301", url: "https://example.test/decomposed", description: "plain" },
    { id: 15, title: null, url: "https://example.test/null", description: null },
    { id: 16, title: "", url: "https://example.test/empty", description: "" },
    { id: 17, title: "Trailing ", url: "https://example.test/space", description: "plain" },
    { id: 18, title: "Trailing", url: "https://example.test/space2", description: "plain" },
    { id: 19, title: "İstanbul", url: "https://example.test/turkish", description: "plain" },
    { id: 20, title: "istanbul", url: "https://example.test/turkish2", description: "plain" },
    { id: 21, title: "zebra", url: "https://example.test/zebra", description: "plain" },
  ];
  const comparisons: Array<{ kind: string; input: string; mysql: number[]; postgres: number[]; equal: boolean }> = [];
  const corrected: Array<{ kind: string; input: string; mysql: number[]; postgres: number[]; equal: boolean }> = [];
  try {
    await source.query("CREATE TEMPORARY TABLE collation_corpus(id INT PRIMARY KEY,title VARCHAR(255),url VARCHAR(255),description TEXT) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci");
    await operator.query("CREATE TEMP TABLE collation_corpus(id integer PRIMARY KEY,title text,url text,description text)");
    for (const row of corpus) {
      await source.execute("INSERT INTO collation_corpus(id,title,url,description) VALUES(?,?,?,?)", [row.id, row.title, row.url, row.description]);
      await operator.query("INSERT INTO collation_corpus(id,title,url,description) VALUES($1,$2,$3,$4)", [row.id, row.title, row.url, row.description]);
    }
    const record = (kind: string, input: string, mysql: number[], postgres: number[]) => comparisons.push({ kind, input, mysql, postgres, equal: JSON.stringify(mysql) === JSON.stringify(postgres) });
    for (const search of ["alpha", "cafe", "CAFÉ", "straße", "strasse", "angstrom", "ไทย", "%", "_value", "100%", "\\", "é", "e\u0301", "istanbul", "null", "does-not-exist"]) {
      const pattern = `%${search}%`;
      const [mysql] = await source.execute<RowDataPacket[]>("SELECT id FROM collation_corpus WHERE title LIKE ? OR url LIKE ? OR description LIKE ? ORDER BY id", [pattern, pattern, pattern]);
      const pg = await operator.query("SELECT id FROM collation_corpus WHERE title ILIKE $1 OR url ILIKE $1 OR description ILIKE $1 ORDER BY id", [pattern]);
      record("search", search, mysql.map((r) => Number(r.id)), pg.rows.map((r) => Number(r.id)));
      const fixed = await operator.query('SELECT id FROM collation_corpus WHERE (title COLLATE "C") ~ $1 OR (url COLLATE "C") ~ $1 OR (description COLLATE "C") ~ $1 ORDER BY id', [legacyLikeRegex(pattern)]);
      const sourceIds = mysql.map((r) => Number(r.id)), targetIds = fixed.rows.map((r) => Number(r.id));
      corrected.push({ kind: "search", input: search, mysql: sourceIds, postgres: targetIds, equal: JSON.stringify(sourceIds) === JSON.stringify(targetIds) });
    }
    for (const title of ["Alpha", "cafe", "café", "strasse", "angstrom", "é", "e\u0301", "Trailing", "Trailing ", "istanbul", ""]) {
      const [mysql] = await source.execute<RowDataPacket[]>("SELECT id FROM collation_corpus WHERE title = ? ORDER BY id", [title]);
      const pg = await operator.query("SELECT id FROM collation_corpus WHERE lower(title)=lower($1) ORDER BY id", [title]);
      record("group-title-equality", title, mysql.map((r) => Number(r.id)), pg.rows.map((r) => Number(r.id)));
      const sourceIds = mysql.map((r) => Number(r.id)), targetIds = corpus.filter((row) => row.title !== null && legacyTextEqual(row.title, title)).map((row) => row.id);
      corrected.push({ kind: "group-title-equality", input: title, mysql: sourceIds, postgres: targetIds, equal: JSON.stringify(sourceIds) === JSON.stringify(targetIds) });
    }
    const [mysqlOrder] = await source.query<RowDataPacket[]>("SELECT id FROM collation_corpus ORDER BY title ASC,url ASC");
    const pgOrder = await operator.query("SELECT id FROM collation_corpus ORDER BY lower(title),id");
    record("feed-title-order", "title ASC,url ASC vs lower(title),id", mysqlOrder.map((r) => Number(r.id)), pgOrder.rows.map((r) => Number(r.id)));
    const rawOrderedFeeds = mysqlOrder.map((row) => corpus.find((feed) => feed.id === Number(row.id))!);
    const effectiveSourceFeedOrder = oracle<number[]>("feed-order", { feeds: rawOrderedFeeds });
    const effectiveTargetFeedOrder = legacySortFeeds(rawOrderedFeeds).map((row) => row.id);
    corrected.push({ kind: "effective-feed-order", input: "actual PHP relationships() fragment vs production legacySortFeeds, seeded by source SQL order", mysql: effectiveSourceFeedOrder, postgres: effectiveTargetFeedOrder, equal: JSON.stringify(effectiveSourceFeedOrder) === JSON.stringify(effectiveTargetFeedOrder) });
    const sourceRawOrder = mysqlOrder.map((r) => Number(r.id));
    const targetRawOrder = [...corpus].sort((a, b) => legacyTextCompare(a.title, b.title) || legacyTextCompare(a.url, b.url)).map((row) => row.id);
    corrected.push({ kind: "raw-sql-order", input: "MySQL title,url UCA vs production legacyTextCompare", mysql: sourceRawOrder, postgres: targetRawOrder, equal: JSON.stringify(sourceRawOrder) === JSON.stringify(targetRawOrder) });
    const numericFeeds = ["1", "2", "10", "0", "10a", "", "2.", "10.", "+2", "+10", "-2", "-10", "2e1", "1e2", "9007199254740991", "9007199254740992", "9223372036854775807", "9223372036854775808", null, "ไทย"].map((title, index) => ({ id: index + 1, title, url: `https://numeric.test/${index + 1}` }));
    const numericSource = oracle<number[]>("feed-order", { feeds: numericFeeds });
    const numericTarget = legacySortFeeds(numericFeeds).map((row) => row.id);
    corrected.push({ kind: "numeric-effective-feed-order", input: "integer/decimal/signed/exponent/64-bit/empty title keys", mysql: numericSource, postgres: numericTarget, equal: JSON.stringify(numericSource) === JSON.stringify(numericTarget) });
    await source.query("CREATE TEMPORARY TABLE numeric_feed_corpus(id INT PRIMARY KEY,title VARCHAR(255),url VARCHAR(255)) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci");
    await source.execute(`INSERT INTO numeric_feed_corpus VALUES ${numericFeeds.map(() => "(?,?,?)").join(",")}`, numericFeeds.flatMap((row) => [row.id, row.title, row.url]));
    const [numericRawOrder] = await source.query<RowDataPacket[]>("SELECT id FROM numeric_feed_corpus ORDER BY title ASC,url ASC");
    const seededNumericFeeds = numericRawOrder.map((row) => numericFeeds.find((feed) => feed.id === Number(row.id))!);
    const seededSource = oracle<number[]>("feed-order", { feeds: seededNumericFeeds });
    const seededTarget = legacySortFeeds(seededNumericFeeds).map((row) => row.id);
    corrected.push({ kind: "numeric-seeded-effective-feed-order", input: "source SQL UCA title/url order then actual PHP ksort vs production stable Zend sort", mysql: seededSource, postgres: seededTarget, equal: JSON.stringify(seededSource) === JSON.stringify(seededTarget) });
    const escapeValues = ["ends%", "%starts", "x%x", "back\\slash", "a%", "a\\", "%", "\\", "a\\%", "xa%", "line\n%tail"];
    await source.query("CREATE TEMPORARY TABLE like_escape_corpus(id INT PRIMARY KEY,value TEXT) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci");
    await operator.query("CREATE TEMP TABLE like_escape_corpus(id integer PRIMARY KEY,value text)");
    for (const [index, value] of escapeValues.entries()) {
      await source.execute("INSERT INTO like_escape_corpus VALUES(?,?)", [index + 1, value]);
      await operator.query("INSERT INTO like_escape_corpus VALUES($1,$2)", [index + 1, value]);
    }
    for (const pattern of ["%\\%", "%\\%%", "%\\\\%", "%a\\%", "\\%", "%\\", "a\\", "a\\%"]) {
      const [mysql] = await source.execute<RowDataPacket[]>("SELECT id FROM like_escape_corpus WHERE value LIKE ? ORDER BY id", [pattern]);
      const pg = await operator.query('SELECT id FROM like_escape_corpus WHERE (value COLLATE "C") ~ $1 ORDER BY id', [legacyLikeRegex(pattern)]);
      const sourceIds = mysql.map((r) => Number(r.id)), targetIds = pg.rows.map((r) => Number(r.id));
      corrected.push({ kind: "LIKE-escape-pattern", input: pattern, mysql: sourceIds, postgres: targetIds, equal: JSON.stringify(sourceIds) === JSON.stringify(targetIds) });
    }
    const [sourceColumns] = await source.query<RowDataPacket[]>("SHOW FULL COLUMNS FROM collation_corpus");
    receipt("collation-differential.json", {
      recordedAt: new Date().toISOString(), source: { version: "5.7.24", charset: "utf8", collation: "utf8_unicode_ci", engine: "MyISAM", columns: sourceColumns }, target: identity,
      sourceProvenance: { install: "fever.php install(): table DEFAULT CHARACTER SET utf8 COLLATE utf8_unicode_ci", search: "fever.php build_feeds/build_items LIKE title/link/description", groupEquality: "fever.php add_group() title = ?", order: "fever.php build_feeds() title ASC,url ASC" },
      corpus, numericFeeds, escapeValues, comparisons, effectiveSourceFeedOrder, effectiveTargetFeedOrder, corrected, differingComparisons: comparisons.filter((c) => !c.equal).length, unexplainedDifferences: corrected.filter((c) => !c.equal).length,
      orderingDistinction: "Raw source SQL title/url order differs from the later visible feed_ids order. Visible order runs the actual relationships() PHP low(title(feed).feed_id), ksort fragment; raw SQL differences alone are not a visible-feed-order defect.",
      disposition: "Baseline is characterized separately. Corrected comparisons use the actual production collation helpers and must have zero unexplained differences.",
    });
    assert.equal(comparisons.length, 28);
    assert.deepEqual(comparisons.find((c) => c.kind === "search" && c.input === "alpha")?.mysql, [1, 2]);
    assert.deepEqual(comparisons.find((c) => c.kind === "search" && c.input === "alpha")?.postgres, [1, 2]);
    assert.deepEqual(corrected.filter((c) => !c.equal), [], "Production helper differs from actual MySQL/PHP source");
  } finally { await source.end(); await operator.end(); await closeDatabase(); }
});

import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, writeFile, stat, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeSnapshot } from "../lib/migration/analyze";
import { encodePhp, phpArray, type PhpValue } from "../lib/migration/php";
import { extractSnapshot, inspectSnapshot, snapshotRows } from "../lib/migration/snapshot";
import { freezeRecord, sqliteSource } from "../lib/migration/sources";
import { mapLegacyRow, MappingError } from "../lib/migration/transform";
import { mapStarterRow } from "../lib/migration/starter";
import { LEGACY_TABLES, STARTER_TABLES, type Cell, type SnapshotRow, type SourceAdapter, type SourceTable } from "../lib/migration/types";

type FixtureValues = Record<string, string | number | Buffer | null>;
const cells = (values: FixtureValues): Record<string, Cell> => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? null : { base64: (Buffer.isBuffer(value) ? value : Buffer.from(String(value))).toString("base64") }]));
const row = (table: SourceTable, values: FixtureValues, ordinal = 1): SnapshotRow => ({ kind: "row", table, ordinal, fields: cells(values) });
const frozen = freezeRecord("2026-10-24T00:00:00Z", "Disposable fixture; no live source connected");
const privateDirectory = async () => { const directory = await mkdtemp(join(await realpath(tmpdir()), "fever-migration-test-")); await chmod(directory, 0o700); return directory; };
const config = (extra: Record<string, PhpValue> = {}, prefs: Record<string, PhpValue> = {}) => ({ id: 1, cfg: encodePhp(phpArray({ email: Buffer.from("owner@example.test"), password: Buffer.from("fixture-password-é"), version: 139, ...extra })), prefs: encodePhp(phpArray(prefs)) });
const display = { item_excerpts: -1, item_allows: -1, unread_counts: -1, sort_order: -1 };
const icon = { id: 1, cache: "image/png;base64,iVBORw0KGgo=", url: "favicon.png", url_checksum: 1, last_cached_on_time: 0 };
const feed = (id = 2, extra: FixtureValues = {}) => ({ id, favicon_id: 1, title: "ไทย feed", url: `https://example.test/feed/${id}`, url_checksum: id, site_url: "https://example.test/", domain: "example.test", requires_auth: 0, auth: null, is_spark: 0, prevents_hotlinking: 0, ...display, last_refreshed_on_time: 0, last_updated_on_time: 0, last_added_on_time: 0, ...extra });
const item = (id = 3, extra: FixtureValues = {}) => ({ id, feed_id: 2, uid: `uid-${id}`, title: "", author: null, description: "<p>Raw 🚀 &amp; text</p>", link: `https://example.test/item/${id}`, url_checksum: id, read_on_time: 0, is_saved: 0, created_on_time: 0, added_on_time: 4_294_967_295, ...extra });
const link = (id = 8, extra: FixtureValues = {}) => ({ id, feed_id: 2, item_id: 3, is_blacklisted: 1, is_item: 0, is_local: 1, is_first: 0, title: null, url: "https://example.test/elsewhere", url_checksum: 12, title_url_checksum: 13, weight: 4_294_967_295, created_on_time: 0, ...extra });

async function fixtureSnapshot(data: Partial<Record<SourceTable, FixtureValues[]>>, path?: string) {
  const output = path ?? join(await privateDirectory(), "source.ndjson");
  let closed = false;
  const columns = (table: SourceTable) => [...new Set((data[table] ?? [{ id: 0 }]).flatMap(values => Object.keys(values)))];
  const source: SourceAdapter = {
    header: { kind: "header", format: 1, source: "mysql", createdAt: "2026-10-24T00:00:00Z", freeze: frozen, metadata: { database: "fixture", version: "fixture", charset: "binary", collation: "binary", engines: {} } },
    tables: LEGACY_TABLES,
    async columns(table) { return columns(table); },
    async *rows(table) { for (const values of data[table] ?? []) yield cells(Object.fromEntries(columns(table).map(column => [column, values[column] ?? null]))); },
    async close() { closed = true; },
  };
  const footer = await extractSnapshot(source, output);
  assert.equal(closed, true);
  const snapshot = await inspectSnapshot(output);
  assert.equal(snapshot.footer.fingerprint, footer.fingerprint);
  return snapshot;
}

test("snapshot retains every cell byte, NULL/empty distinction, unsigned max ID and private file mode", async () => {
  const original = { id: 4_294_967_295, title: Buffer.from([0, 255, 13, 10]), empty: "", absent: null };
  const snapshot = await fixtureSnapshot({ groups: [original] });
  const rows = [];
  for await (const sourceRow of snapshotRows(snapshot)) rows.push(sourceRow);
  assert.deepEqual(rows, [row("groups", original)]);
  assert.equal(snapshot.footer.tables.groups.maxId, "4294967295");
  assert.equal(snapshot.footer.tables.groups.rows, 1);
  assert.equal(Object.keys(snapshot.footer.tables).length, LEGACY_TABLES.length);
  assert.equal((await stat(snapshot.path)).mode & 0o777, 0o600);
  assert.notEqual(snapshot.footer.tables.groups.fieldDigests.empty, snapshot.footer.tables.groups.fieldDigests.absent);
  await assert.rejects(() => fixtureSnapshot({ groups: [original] }, snapshot.path), /EEXIST/);
});

test("snapshot rejects changed bytes, row order, missing/duplicate tables, trailing records and truncation", async () => {
  const snapshot = await fixtureSnapshot({ groups: [{ id: 1, title: "original" }] });
  const original = await readFile(snapshot.path, "utf8");
  const records = original.trimEnd().split("\n").map(line => JSON.parse(line));
  const rowIndex = records.findIndex(record => record.kind === "row");
  const variants = [
    records.map((record, index) => index === rowIndex ? { ...record, fields: { ...record.fields, title: { base64: Buffer.from("changed").toString("base64") } } } : record),
    records.map((record, index) => index === rowIndex ? { ...record, ordinal: 2 } : record),
    records.filter(record => !(record.kind === "table" && record.table === "links")),
    [...records.slice(0, 2), records[1], ...records.slice(2)],
    [...records, records[0]],
    records.slice(0, -1),
  ];
  for (const [index, variant] of variants.entries()) {
    const path = join(await privateDirectory(), `invalid-${index}.ndjson`);
    await writeFile(path, variant.map(record => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
    await assert.rejects(() => inspectSnapshot(path));
  }
  const truncated = join(await privateDirectory(), "truncated.ndjson");
  await writeFile(truncated, original.slice(0, -1));
  await assert.rejects(() => inspectSnapshot(truncated), /truncated/);
  await assert.rejects(() => inspectSnapshot(snapshot.path, 0), /row limit/);
  const replacement = records.map((record, index) => index === rowIndex ? { ...record, fields: { ...record.fields, title: { base64: "YR==" } } } : record);
  await writeFile(snapshot.path, replacement.map(record => JSON.stringify(record)).join("\n") + "\n");
  await assert.rejects(async () => { for await (const ignored of snapshotRows(snapshot)) void ignored; }, /NONCANONICAL_BASE64/);
});

test("legacy transforms preserve IDs, zero/max timestamps, NULL versus empty, and protected credentials", () => {
  const mapped = mapLegacyRow(row("items", item(4_294_967_295, { read_on_time: 4_294_967_295, is_saved: 1 })));
  assert.equal(mapped.kind, "item");
  if (mapped.kind !== "item") throw new Error("Unexpected mapped kind");
  assert.equal(mapped.id, 4_294_967_295);
  assert.equal(mapped.title, ""); assert.equal(mapped.author, null);
  assert.equal(mapped.readAt, 4_294_967_295); assert.equal(mapped.publishedAt, 0);
  assert.equal(mapped.isSaved, true); assert.equal(mapped.rawHtml, "<p>Raw 🚀 &amp; text</p>");
  const credential = Buffer.from("user:password:with:colons");
  const protectedFeed = mapLegacyRow(row("feeds", feed(2, { requires_auth: 1, auth: credential.toString("base64") })));
  assert.equal(protectedFeed.kind, "feed");
  if (protectedFeed.kind === "feed") assert.deepEqual(protectedFeed.credential, credential);
  for (const [extra, code] of [[{ id: 4_294_967_296 }, "INTEGER_RANGE"], [{ is_saved: 2 }, "INVALID_FLAG"], [{ description: Buffer.from([255]) }, "INVALID_TEXT"], [{ title: "nul\0text" }, "INVALID_TEXT"]] as const) {
    assert.throws(() => mapLegacyRow(row("items", item(3, extra))), (error: unknown) => error instanceof MappingError && error.code === code);
  }
});

test("configuration preserves preferences, services, view and unknown keys while refusing unsupported versions", () => {
  const mapped = mapLegacyRow(row("_config", config({ custom: Buffer.from("archived") }, {
    use_celsius: true, per_page: 200, item_expiration: 4, blacklist: Buffer.from("example.test"), custom: Buffer.from("archived"),
    ui: phpArray({ section: 2, previous: 1, group_id: 4_294_967_295, feed_id: 2, show_read: 0, search: Buffer.from("ไทย"), custom: 1 }),
    services: { kind: "array", entries: [[0, phpArray({ name: Buffer.from("Unsafe"), url: Buffer.from("javascript:alert(1)"), key: Buffer.from("x") })], [1, phpArray({ name: Buffer.from("Background"), url: Buffer.from("#https://example.test/share?url=%u"), key: Buffer.from("b") })]] },
  })));
  assert.equal(mapped.kind, "config");
  if (mapped.kind !== "config") throw new Error("Unexpected mapped kind");
  assert.equal(mapped.preferences.useCelsius, true); assert.equal(mapped.preferences.perPage, 200);
  assert.equal(mapped.preferences.itemExpiration, 4); assert.equal(mapped.preferences.blacklist, "example.test");
  assert.equal(mapped.view.section, "saved"); assert.equal(mapped.view.previous, "kindling");
  assert.equal(mapped.view.groupId, 4_294_967_295); assert.equal(mapped.view.showRead, false); assert.equal(mapped.view.search, "ไทย");
  assert.equal(mapped.preferences.services[0].url, "javascript:alert(1)"); assert.equal(mapped.preferences.services[0].enabled, false);
  assert.equal(mapped.preferences.services[1].enabled, true);
  assert.deepEqual(mapped.password, Buffer.from("fixture-password-é"));
  assert.deepEqual(mapped.unknownKeys.sort(), ["cfg.custom", "prefs.custom", "prefs.ui.custom"]);
  assert.throws(() => mapLegacyRow(row("_config", config({ version: 124 }))), /Versions below 125/);
  assert.throws(() => mapLegacyRow(row("_config", config({ version: 140 }))));
});

test("legacy favicon, display overrides and link occurrence flags retain their source meaning", () => {
  const favicon = mapLegacyRow(row("favicons", icon));
  assert.equal(favicon.kind, "favicon");
  if (favicon.kind === "favicon") {
    assert.deepEqual(favicon.data, Buffer.from("iVBORw0KGgo=", "base64"));
    assert.equal(favicon.mime, "image/png"); assert.equal(favicon.cachedAt, 0);
  }
  assert.throws(() => mapLegacyRow(row("favicons", { ...icon, cache: "image/jpeg;base64,iVBORw0KGgo=" })), /declared MIME/);
  const group = mapLegacyRow(row("groups", { id: 7, title: "Group", ...display, item_allows: 2, sort_order: 1 }));
  assert.equal(group.kind, "group");
  if (group.kind === "group") { assert.equal(group.itemExcerpts, -1); assert.equal(group.itemAllows, 2); assert.equal(group.sortOrder, 1); }
  assert.throws(() => mapLegacyRow(row("groups", { id: 7, title: "Group", ...display, item_allows: 3 })), /Invalid display override/);
  const occurrence = mapLegacyRow(row("links", link()));
  assert.equal(occurrence.kind, "link");
  if (occurrence.kind === "link") {
    assert.equal(occurrence.id, 8); assert.equal(occurrence.feedId, 2); assert.equal(occurrence.itemId, 3);
    assert.equal(occurrence.isBlacklisted, true); assert.equal(occurrence.isItem, false);
    assert.equal(occurrence.isLocal, true); assert.equal(occurrence.isFirst, false);
    assert.equal(occurrence.title, null); assert.equal(occurrence.weight, 4_294_967_295); assert.equal(occurrence.createdAt, 0);
  }
});

test("analysis accounts for duplicates, orphan rows, invalid Unicode and every source field", async () => {
  const snapshot = await fixtureSnapshot({ _config: [config()], groups: [{ id: 7, title: "Group", ...display }], favicons: [icon], feeds: [feed()], feeds_groups: [{ feed_id: 2, group_id: 7 }, { feed_id: 2, group_id: 7 }, { feed_id: 2, group_id: 999 }], items: [item(3, { read_on_time: 123, is_saved: 1, custom: "archive me" }), item(4), item(5, { feed_id: 999 }), item(6, { title: Buffer.from([255]) })] });
  const { report, dispositions } = await analyzeSnapshot(snapshot);
  assert.equal(report.conservation, true); assert.equal(report.readyToImport, false);
  assert.deepEqual(report.state, { read: 1, unread: 1, saved: 1, memberships: 1 });
  assert.deepEqual(report.counts.feeds_groups, { source: 3, import: 1, quarantine: 1, duplicateMembership: 1 });
  assert.deepEqual(report.counts.items, { source: 4, import: 2, quarantine: 2, duplicateMembership: 0 });
  assert.equal(dispositions.get("items:1")?.fields.custom, "restricted-archive");
  assert.equal(dispositions.get("items:1")?.fields.author, "restricted-archive");
  assert.equal(dispositions.get("items:1")?.fields.description, "mapped");
  assert.ok(report.issues.some(issue => issue.code === "UNKNOWN_COLUMN" && issue.severity === "warning"));
  assert.ok(report.issues.some(issue => issue.code === "INVALID_TEXT"));
  assert.ok(report.issues.some(issue => issue.code === "ORPHAN_OR_QUARANTINED_PARENT"));
  assert.equal(dispositions.size, Object.values(report.counts).reduce((sum, count) => sum + count.source, 0));
  assert.deepEqual(report.fieldDigests.items, snapshot.footer.tables.items.fieldDigests);
});

test("a checksum-conflicting quarantined item cannot reserve the UID of a later valid item", async () => {
  const snapshot = await fixtureSnapshot({ _config: [config()], favicons: [icon], feeds: [feed()], items: [
    item(3, { url_checksum: 10 }),
    item(4, { uid: "later-valid-uid", url_checksum: 10 }),
    item(5, { uid: "later-valid-uid", url_checksum: 11 }),
  ] });
  const analysis = await analyzeSnapshot(snapshot);
  assert.equal(analysis.dispositions.get("items:1")?.disposition, "import");
  assert.equal(analysis.dispositions.get("items:2")?.disposition, "quarantine");
  assert.equal(analysis.dispositions.get("items:3")?.disposition, "import");
  assert.deepEqual(analysis.report.state, { read: 0, unread: 2, saved: 0, memberships: 0 });
  assert.equal(analysis.report.issues.filter(issue => issue.code === "LEGACY_CHECKSUM_COLLISION").length, 1);
  assert.equal(analysis.report.issues.filter(issue => issue.code === "DUPLICATE_UID").length, 0);
});

test("healthy legacy snapshot is importable while mismatched link ancestry is explicitly quarantined", async () => {
  const fixture = { _config: [config()], groups: [{ id: 7, title: "Group", ...display }], favicons: [icon], feeds: [feed(), feed(9)], feeds_groups: [{ feed_id: 2, group_id: 7 }, { feed_id: 2, group_id: 7 }], items: [item()], links: [link()] };
  const healthy = await analyzeSnapshot(await fixtureSnapshot(fixture));
  assert.equal(healthy.report.readyToImport, true); assert.equal(healthy.report.conservation, true);
  assert.equal(healthy.report.sourceVersion, 139); assert.equal(healthy.report.state.memberships, 1);
  assert.equal(healthy.report.counts.links.import, 1);
  const invalid = await analyzeSnapshot(await fixtureSnapshot({ ...fixture, links: [link(8, { feed_id: 9 })] }));
  assert.equal(invalid.report.readyToImport, false); assert.equal(invalid.report.conservation, true);
  assert.equal(invalid.dispositions.get("links:1")?.disposition, "quarantine");
  assert.ok(invalid.report.issues.some(issue => issue.code === "LINK_FEED_MISMATCH"));
});

test("a quarantined starter feed must not reserve URL identity against a subsequent valid feed", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "starter.db");
  await makeStarter(path);
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path);
  db.prepare('UPDATE "Feed" SET groupId=999 WHERE id=2').run();
  db.prepare('INSERT INTO "Feed" VALUES(3,?, ?, NULL,1,1,?)').run("https://example.test/feed", "Valid second feed", 1_700_000_000_000);
  db.close();
  const source = await sqliteSource(path, frozen);
  const output = join(directory, "source.ndjson");
  await extractSnapshot(source, output);
  const analysis = await analyzeSnapshot(await inspectSnapshot(output));
  assert.equal(analysis.dispositions.get("Feed:1")?.disposition, "quarantine");
  assert.equal(analysis.dispositions.get("Feed:2")?.disposition, "import");
});

async function makeStarter(path: string) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path);
  db.exec('CREATE TABLE "User"(id INTEGER PRIMARY KEY,email TEXT,password TEXT,createdAt INTEGER); CREATE TABLE "Group"(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE "Feed"(id INTEGER PRIMARY KEY,url TEXT,title TEXT,siteUrl TEXT,groupId INTEGER,userId INTEGER,createdAt INTEGER); CREATE TABLE "Item"(id INTEGER PRIMARY KEY,feedId INTEGER,title TEXT,link TEXT,content TEXT,pubDate INTEGER,read INTEGER,createdAt INTEGER)');
  db.prepare('INSERT INTO "User" VALUES(1,?,?,?)').run("owner@example.test", "fixture-password", 1_700_000_000_000);
  db.prepare('INSERT INTO "Group" VALUES(1,?)').run("ไทย Group");
  db.prepare('INSERT INTO "Feed" VALUES(2,?,?,NULL,1,1,?)').run("https://example.test/feed", "Feed", 1_700_000_000_000);
  db.prepare('INSERT INTO "Item" VALUES(3,2,?,?,?, ?,1,?)').run("Item 🚀", "https://example.test/item", "<p>Original content</p>", 1_700_000_000_000, 1_700_000_001_000);
  db.close();
}

test("populated SQLite starter exports read-only with exact IDs/content and explicit absent-field defaults", async () => {
  const directory = await privateDirectory(); const path = join(directory, "starter.db");
  await makeStarter(path);
  const before = await readFile(path);
  const source = await sqliteSource(path, frozen);
  assert.deepEqual(source.tables, STARTER_TABLES);
  const output = join(directory, "source.ndjson");
  await extractSnapshot(source, output);
  assert.deepEqual(await readFile(path), before, "read-only export must leave source bytes unchanged");
  const snapshot = await inspectSnapshot(output);
  const { report, dispositions } = await analyzeSnapshot(snapshot);
  assert.equal(report.readyToImport, true); assert.equal(report.conservation, true);
  assert.deepEqual(report.state, { read: 1, unread: 0, saved: 0, memberships: 1 });
  assert.ok(report.issues.some(issue => issue.code === "STARTER_ABSENT_FIELDS" && issue.severity === "warning"));
  assert.equal(dispositions.get("Feed:1")?.fields.createdAt, "restricted-archive");
  const rows: SnapshotRow[] = []; for await (const entry of snapshotRows(snapshot)) rows.push(entry);
  const mapped = mapStarterRow(rows.find(entry => entry.table === "Item")!);
  assert.equal(mapped.kind, "item");
  if (mapped.kind === "item") {
    assert.equal(mapped.id, 3); assert.equal(mapped.feedId, 2); assert.equal(mapped.uid, "starter:3");
    assert.equal(mapped.title, "Item 🚀"); assert.equal(mapped.rawHtml, "<p>Original content</p>");
    assert.equal(mapped.publishedAt, 1_700_000_000); assert.equal(mapped.addedAt, 1_700_000_001);
    assert.equal(mapped.readAt, 1); assert.equal(mapped.isSaved, false);
  }
  const itemRow = rows.find(entry => entry.table === "Item")!;
  assert.throws(() => mapStarterRow({ ...itemRow, fields: { ...itemRow.fields, pubDate: cells({ date: 1_700_000_000_001 }).date } }), /loses milliseconds/);
  assert.throws(() => mapStarterRow({ ...itemRow, fields: { ...itemRow.fields, read: cells({ flag: 2 }).flag } }), /Invalid starter read flag/);
  const link = join(directory, "alias.db"); await symlink(path, link);
  await assert.rejects(() => sqliteSource(link, frozen), /non-symlink/);
  await assert.rejects(() => sqliteSource("relative.db", frozen), /non-symlink/);
});

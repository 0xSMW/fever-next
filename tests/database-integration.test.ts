import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { SCHEMA_VERSION } from "../lib/config";
import { closeDatabase, getDb, getPool } from "../lib/db/client";
import { apiFlag, epochToDate, safeInteger, toChecksum, toEpochSeconds, toFiniteNumber, toId } from "../lib/db/numbers";
import { items } from "../lib/db/schema";
import { assertSchema, assertTarget, connectTarget, lockTarget, reconcileSequences } from "../lib/migration/target";
import { createFeed, updateFeed, deleteFeed, createGroup, updateGroup, deleteGroup, changeMembership, updateSparks, deleteSparks } from "../lib/domain/subscriptions";
import { getNavigation, getReaderView } from "../lib/domain/reader";
import { captureReaderView, getPreferences, getViewState, savePreferences, saveView } from "../lib/domain/preferences";
import { markScopeRead, mutateItems, undoOperation, undoRecentlyRead } from "../lib/domain/state";
import { resolveDisplayOptions } from "../lib/domain/options";
import { enqueueInstallationRefresh } from "../lib/jobs";
import { assertLease, claimFeed, claimJob } from "../lib/jobs/worker";
import { LostLeaseError } from "../lib/jobs/types";

// This suite mutates fixtures. Opt-in alone is insufficient: this exact disposable
// branch was created and reviewed for integration tests, separately from web QA.
const endpoint = "ep-silent-snow-aroq4quy.c-4.us-west-2.aws.neon.tech";
const fingerprint = "d3e876746c7f0a6b829a26d9a9384d2628c1fb2c630a4078ac25451b23d56d9b";
const enabled = process.env.FEVER_INTEGRATION_TESTS === "1";
const node24 = process.execPath;

test("isolated PostgreSQL schema, domain and queue integration", { skip: !enabled, timeout: 600_000 }, async (t) => {
  assert.equal(process.versions.node.split(".")[0], "24", "Use the reviewed Node 24 runtime");
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, endpoint, "Refusing a different database branch");
  const operator = await connectTarget(process.env.DATABASE_URL!);
  const pool = getPool();
  const owner = { id: 1, email: `integration-${randomUUID()}@example.test` };
  const prefix = `integration-${randomUUID()}`;
  let ownsOwner = false;
  let originalStatus = "uninitialized";
  const sql = (query: string, values?: unknown[]) => pool.query(query, values);
  const state = async (id: number) => (await sql("SELECT read_at,is_saved,state_version FROM items WHERE id=$1", [id])).rows[0];
  const addItem = async (feedId: number, name: string, addedAt: number, publishedAt = addedAt, extra: { title?: string; rawHtml?: string } = {}) => {
    const [row] = await getDb().insert(items).values({ feedId, identityKey: `${prefix}-${name}`, title: extra.title ?? name,
      rawHtml: extra.rawHtml ?? `<p>${name}</p>`, html: `<p>${name}</p>`, searchText: name,
      url: `https://example.test/${name}`, canonicalUrl: `https://example.test/${name}`, publishedAt, addedAt }).returning({ id: items.id });
    return row.id;
  };
  const rejectedSql = async (query: string, values: unknown[], code: string) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query(query, values), (error: unknown) => (error as { code?: string }).code === code);
    } finally { await client.query("ROLLBACK"); client.release(); }
  };
  try {
    await assertTarget(operator, process.env.DATABASE_URL!, fingerprint);
    await assertSchema(operator);
    const existing = await sql("SELECT count(*)::int AS count FROM owner");
    assert.equal(existing.rows[0].count, 0, "Refusing to replace an existing installation owner");
    originalStatus = (await sql("SELECT status FROM installation WHERE id=1")).rows[0].status;
    assert.equal(originalStatus, "uninitialized", "Refusing an active installation");
    await sql("INSERT INTO owner(id,email,email_key,password_hash) VALUES(1,$1,$2,'integration-fixture-only')", [owner.email, owner.email]);
    ownsOwner = true;
    await sql("INSERT INTO reader_preferences(owner_id) VALUES(1)");
    await sql("UPDATE installation SET status='ready' WHERE id=1");

    await t.test("reviewed migration repeats without changes; version and lock gates fail closed", async () => {
      const before = (await sql("SELECT version,filename,sha256,applied_at FROM fever_schema_migrations ORDER BY version")).rows;
      const args = ["--conditions=react-server", "--import", "tsx", "scripts/migrate.ts", "apply", "--target-url-env", "DATABASE_URL", "--target-fingerprint", fingerprint, "--confirm", `migrate:${fingerprint}`];
      const result = JSON.parse(execFileSync(node24, args, { encoding: "utf8", timeout: 30_000 }));
      assert.equal(result.ok, true);
      assert.equal(result.schemaVersion, SCHEMA_VERSION);
      assert.deepEqual((await sql("SELECT version,filename,sha256,applied_at FROM fever_schema_migrations ORDER BY version")).rows, before);
      await operator.query("BEGIN");
      try {
        await operator.query("UPDATE installation SET schema_version=$1 WHERE id=1", [SCHEMA_VERSION + 1]);
        await assert.rejects(assertSchema(operator), /schema version/);
      } finally { await operator.query("ROLLBACK"); }
      await assert.rejects(assertTarget(operator, process.env.DATABASE_URL!, "0".repeat(64)), /fingerprint/);
      await lockTarget(operator);
      const second = await connectTarget(process.env.DATABASE_URL!);
      try { await assert.rejects(lockTarget(second), /holds the target lock/); }
      finally { await second.end(); await operator.query("SELECT pg_advisory_unlock_all()"); }
    });

    await t.test("PostgreSQL UTC, UTF-8, exact numerics and JSON boundaries", async () => {
      const row = (await sql("SELECT current_setting('TimeZone') AS tz,current_setting('server_encoding') AS encoding,4294967295::bigint AS crc,9007199254740991::bigint AS safe,0::bigint AS zero,0.1::numeric AS decimal")).rows[0];
      assert.equal(row.tz, "UTC"); assert.equal(row.encoding, "UTF8");
      assert.equal(typeof row.crc, "string"); assert.equal(toChecksum(row.crc), 4294967295);
      assert.equal(toId(row.safe), Number.MAX_SAFE_INTEGER); assert.equal(toEpochSeconds(row.zero), 0);
      assert.equal(toFiniteNumber(row.decimal), 0.1); assert.equal(epochToDate(0).toISOString(), "1970-01-01T00:00:00.000Z");
      assert.equal(apiFlag(true), 1); assert.equal(apiFlag(false), 0);
      for (const value of ["9007199254740992", 9007199254740992, "1.2", "1e3", NaN, Infinity]) assert.throws(() => safeInteger(value));
      assert.throws(() => toChecksum("4294967296"));
      assert.deepEqual((await sql("SELECT $1::jsonb AS document", [JSON.stringify({ zero: 0, nil: null, text: "ไทย 🚀", list: [true, false] })])).rows[0].document,
        { zero: 0, nil: null, text: "ไทย 🚀", list: [true, false] });
    });

    const g1 = await createGroup(owner, { title: `${prefix} one` });
    const g2 = await createGroup(owner, { title: `${prefix} two` });
    const f1 = await createFeed(owner, { url: `https://example.test/${prefix}/one.xml`, title: "Mixed CASE ไทย", groupIds: [g1.id, g2.id] });
    const f2 = await createFeed(owner, { url: `https://example.test/${prefix}/two.xml`, title: "Spark fixture", groupIds: [g1.id], isSpark: true });
    const f3 = await createFeed(owner, { url: `https://example.test/${prefix}/three.xml`, title: "Other fixture" });

    await t.test("database checks, unique memberships, same-link identities and cascades", async () => {
      await rejectedSql("INSERT INTO installation(id) VALUES(2)", [], "23514");
      await rejectedSql("INSERT INTO owner(id,email,email_key,password_hash) VALUES(2,'x','x','x')", [], "23514");
      await rejectedSql("UPDATE feeds SET url_checksum=4294967296 WHERE id=$1", [f1.id], "23514");
      await rejectedSql("UPDATE feeds SET id=9007199254740992 WHERE id=$1", [f1.id], "23514");
      await rejectedSql("UPDATE feeds SET item_allows=3 WHERE id=$1", [f1.id], "23514");
      await rejectedSql("INSERT INTO feed_groups(feed_id,group_id) VALUES($1,$2)", [f1.id, g1.id], "23505");
      await rejectedSql("INSERT INTO feed_groups(feed_id,group_id) VALUES($1,9007199254740991)", [f1.id], "23503");
      const a = await addItem(f3.id, "same-link-a", 1); const b = await addItem(f3.id, "same-link-b", 1);
      await sql("UPDATE items SET url='https://example.test/same-link',url_checksum=4294967295 WHERE id=ANY($1::bigint[])", [[a, b]]);
      assert.equal((await sql("SELECT count(*)::int AS count FROM items WHERE feed_id=$1", [f3.id])).rows[0].count, 2);
      await rejectedSql("INSERT INTO items(feed_id,identity_key,published_at,added_at) SELECT feed_id,identity_key,0,0 FROM items WHERE id=$1", [a], "23505");
      await rejectedSql("UPDATE items SET added_at=-1 WHERE id=$1", [a], "23514");
      const bytes = Buffer.from([0, 255, 13, 10]);
      const binary = await sql("INSERT INTO favicons(owner_id,url,url_key,content_hash,data) VALUES(1,$1,$2,$2,$3) RETURNING data", [`https://example.test/${prefix}/icon`, prefix, bytes]);
      assert.deepEqual(binary.rows[0].data, bytes);
      await sql("DELETE FROM items WHERE id=ANY($1::bigint[])", [[a, b]]);
    });

    await t.test("createFeed reports only memberships actually inserted", async () => {
      assert.equal(f1.membershipsAdded, 2);
      assert.equal(f2.membershipsAdded, 1);
      const repeat = await createFeed(owner, { url: `https://example.test/${prefix}/one.xml`, groupIds: [g1.id, g2.id] });
      assert.equal(repeat.created, false);
      assert.equal(repeat.membershipsAdded, 0);
      const newlyJoined = await createFeed(owner, { url: `https://example.test/${prefix}/three.xml`, groupIds: [g2.id] });
      assert.equal(newlyJoined.membershipsAdded, 1);
      await changeMembership(owner, { feedId: f3.id, groupId: g2.id }, false);
    });

    await t.test("feed/group lifecycle and many-to-many membership are transactional", async () => {
      assert.equal((await createGroup(owner, { title: "Kindling" })).id, 0);
      assert.equal((await createGroup(owner, { title: `${prefix} ONE` })).id, g1.id);
      assert.equal((await createFeed(owner, { url: `https://example.test/${prefix}/one.xml` })).id, f1.id);
      assert.deepEqual((await getNavigation(owner)).feeds.find(row => row.id === f1.id)!.groupIds, [g1.id, g2.id]);
      await changeMembership(owner, { feedId: f1.id, groupId: g1.id }, false);
      assert.equal((await getNavigation(owner)).feeds.find(row => row.id === f1.id)!.groupIds.length, 1);
      await changeMembership(owner, { feedId: f1.id, groupId: g1.id }, true);
      assert.equal((await changeMembership(owner, { feedId: f1.id, groupId: g1.id }, true)).changed, 0);
      const before = (await sql("SELECT * FROM feeds WHERE id=$1", [f1.id])).rows;
      await assert.rejects(updateFeed(owner, { id: f1.id, title: "should roll back", groupIds: [9007199254740991] }), (error: unknown) => (error as { code?: string }).code === "NOT_FOUND");
      assert.deepEqual((await sql("SELECT * FROM feeds WHERE id=$1", [f1.id])).rows, before);
      await updateGroup(owner, { id: g2.id, title: `${prefix} renamed`, sortOrder: 1 });
      await assert.rejects(updateGroup(owner, { id: g2.id, title: `${prefix} one` }), (error: unknown) => (error as { code?: string }).code === "DUPLICATE_GROUP");
      const fence = (await sql("SELECT fence FROM feed_fetch_state WHERE feed_id=$1", [f1.id])).rows[0].fence;
      await updateFeed(owner, { id: f1.id, url: `https://example.test/${prefix}/changed.xml`, title: "Custom title", groupIds: [g1.id, g2.id] });
      assert.equal(BigInt((await sql("SELECT fence FROM feed_fetch_state WHERE feed_id=$1", [f1.id])).rows[0].fence), BigInt(fence) + 1n);
      await updateFeed(owner, { id: f1.id, title: "" });
      assert.equal((await getNavigation(owner)).feeds.find(row => row.id === f1.id)!.title, "Mixed CASE ไทย");
      await assert.rejects(createFeed({ ...owner, email: "wrong@example.test" }, { url: "https://example.test/unauthorized.xml" }), (error: unknown) => (error as { code?: string }).code === "UNAUTHORIZED");
    });

    const beforeCutoff = await addItem(f1.id, "before-cutoff", 99);
    const atCutoff = await addItem(f1.id, "at-cutoff", 100);
    const afterCutoff = await addItem(f1.id, "after-cutoff", 101);
    const sparkItem = await addItem(f2.id, "spark-cutoff", 99);
    const apiSaveItem = await addItem(f3.id, "api-save", 99);

    await t.test("read/save commands preserve strict cutoff, API/UI semantics and journal undo", async () => {
      const marked = await markScopeRead(owner, { scope: "group", id: g1.id, before: 100 });
      assert.equal(marked.changed, 2); // custom group includes its Spark affiliation
      assert.notEqual((await state(beforeCutoff)).read_at, "0"); assert.notEqual((await state(sparkItem)).read_at, "0");
      assert.equal((await state(atCutoff)).read_at, "0"); assert.equal((await state(afterCutoff)).read_at, "0");
      const readAt = (await state(beforeCutoff)).read_at;
      assert.equal((await mutateItems(owner, "read", [beforeCutoff])).changed, 0);
      assert.equal((await state(beforeCutoff)).read_at, readAt);
      const saved = await mutateItems(owner, "save", [atCutoff]);
      assert.equal((await state(atCutoff)).is_saved, true); assert.notEqual((await state(atCutoff)).read_at, "0");
      assert.equal((await undoOperation(owner, saved.operationId!)).changed, 1);
      assert.equal((await state(atCutoff)).is_saved, false); assert.equal((await state(atCutoff)).read_at, "0");
      assert.equal((await undoOperation(owner, saved.operationId!)).changed, 0);
      await mutateItems(owner, "save", [apiSaveItem], { origin: "api" });
      assert.equal((await state(apiSaveItem)).is_saved, true); assert.equal((await state(apiSaveItem)).read_at, "0");
      const reading = await mutateItems(owner, "read", [afterCutoff]);
      await mutateItems(owner, "save", [afterCutoff]);
      await assert.rejects(undoOperation(owner, reading.operationId!), (error: unknown) => (error as { code?: string }).code === "UNDO_CONFLICT");
      await assert.rejects(mutateItems(owner, "read", [beforeCutoff, 9007199254740991]), (error: unknown) => (error as { code?: string }).code === "NOT_FOUND");
      assert.equal((await state(beforeCutoff)).read_at, readAt);
      await sql("UPDATE items SET read_at=CASE WHEN id=$1 THEN 1000 WHEN id=$2 THEN 985 WHEN id=$3 THEN 986 ELSE 0 END", [beforeCutoff, atCutoff, sparkItem]);
      assert.equal((await undoRecentlyRead(owner, "kindling")).changed, 2); // >985, including Spark
      assert.equal((await state(atCutoff)).read_at, "985"); assert.equal((await state(sparkItem)).read_at, "0");
      await mutateItems(owner, "unread", [beforeCutoff, atCutoff, afterCutoff, sparkItem, apiSaveItem]);
      assert.equal((await markScopeRead(owner, { scope: "feed", id: f1.id, before: 100 })).changed, 1);
      assert.equal((await markScopeRead(owner, { scope: "sparks", before: 100 })).changed, 1);
      assert.equal((await markScopeRead(owner, { scope: "all", before: 100 })).changed, 1);
      assert.equal((await state(atCutoff)).read_at, "0"); assert.equal((await state(afterCutoff)).read_at, "0");
    });

    await t.test("preferences preserve absent settings, optimistic versions, services and display inheritance", async () => {
      const before = await getPreferences(owner);
      const saved = await savePreferences(owner, { version: before.version, perPage: 2, autoRead: false,
        services: [{ name: "Email", url: "mailto:?subject=%t&body=%u", key: "e" }, { name: "Unsafe", url: "javascript:alert(1)", key: "x" }] });
      assert.equal(saved.preferences.perPage, 2); assert.equal(saved.preferences.autoRead, false);
      assert.equal(saved.preferences.refreshInterval, before.refreshInterval);
      assert.equal(saved.preferences.services[0].enabled, true); assert.equal(saved.preferences.services[1].enabled, false);
      await assert.rejects(savePreferences(owner, { version: before.version, perPage: 3 }), (error: unknown) => (error as { code?: string }).code === "CONFLICT");
      assert.equal((await getPreferences(owner)).perPage, 2);
      const inherited = { itemExcerpts: -1, itemAllows: -1, unreadCounts: -1, sortOrder: -1 };
      for (const section of ["kindling", "sparks", "saved", "search", "hot"] as const) {
        const group = { itemExcerpts: 0, itemAllows: 2, unreadCounts: 1, sortOrder: 1 };
        const resolved = resolveDisplayOptions(saved.preferences, { section, groupId: g1.id }, group, inherited);
        assert.equal(resolved.itemAllows, section === "kindling" ? 2 : saved.preferences.itemAllows);
        assert.equal(resolveDisplayOptions(saved.preferences, { section, groupId: g1.id }, group, { ...inherited, itemAllows: 0 }).itemAllows, 0);
      }
    });

    await t.test("capture:false queries preserve navigation, reading boundaries and journal", async () => {
      const preferences = await getPreferences(owner);
      await captureReaderView(owner, { section: "kindling", groupId: g1.id, feedId: f1.id, deviceKey: "integration" }, preferences);
      await sql("UPDATE reader_view_state SET last_viewed_at=10,last_session_at=5 WHERE owner_id=1 AND device_id='integration'");
      const before = (await sql("SELECT * FROM reader_view_state WHERE owner_id=1 ORDER BY device_id")).rows;
      const journals = (await sql("SELECT count(*)::int AS count FROM state_operations")).rows[0].count;
      const response = await getReaderView(owner, { section: "saved", groupId: g1.id, deviceKey: "integration" }, { capture: false });
      assert.equal(response.view.groupId, 0);
      assert.deepEqual((await sql("SELECT * FROM reader_view_state WHERE owner_id=1 ORDER BY device_id")).rows, before);
      assert.equal((await sql("SELECT count(*)::int AS count FROM state_operations")).rows[0].count, journals);
      await saveView(owner, { hasFocus: "items", deviceKey: "integration" });
      const focused = await getViewState(owner, "integration");
      assert.equal(focused.view.hasFocus, "items");
      assert.equal(focused.lastViewedAt, 10, "Focus persistence must not capture another visit");
      assert.equal(focused.lastSessionAt, 5);
      const captured = await captureReaderView(owner, { section: "search", search: "query", deviceKey: "integration" }, preferences);
      assert.equal(captured.lastSessionAt, 10);
      assert.equal((await getViewState(owner, "integration")).view.previous, "kindling");
    });

    await t.test("search is case-insensitive substring/wildcard matching with Unicode and stable tied pages", async () => {
      const first = await addItem(f3.id, "search-one", 200, 200, { title: "Needle ไทย", rawHtml: "<p>Café body</p>" });
      const second = await addItem(f3.id, "search-two", 200, 200, { title: "needle second" });
      const third = await addItem(f3.id, "search-three", 200, 200, { title: "NEEDLE third" });
      const query = { section: "search" as const, search: "nEeDlE", feedId: 0, deviceKey: "search" };
      const page = await getReaderView(owner, query, { capture: false });
      assert.equal(page.totalItems, 3); assert.equal(page.searchCounts!["0"], 3); assert.equal(page.hasMore, true);
      assert.deepEqual(page.items.map(row => row.id), [third, second]);
      const next = await getReaderView(owner, { ...query, cursor: page.nextCursor! }, { capture: false });
      assert.deepEqual(next.items.map(row => row.id), [first]);
      assert.equal((await getReaderView(owner, { ...query, search: "café" }, { capture: false })).totalItems, 1);
      assert.equal((await getReaderView(owner, { ...query, search: "ไทย" }, { capture: false })).totalItems, 1);
      assert.equal((await getReaderView(owner, { ...query, search: "needle%" }, { capture: false })).totalItems, 3);
      assert.equal((await getReaderView(owner, { ...query, search: "" }, { capture: false })).totalItems, 0);
    });

    await t.test("shrinking unread cursor excludes concurrent arrivals without skips", async () => {
      await sql("UPDATE items SET read_at=1 WHERE feed_id=$1", [f3.id]);
      const a = await addItem(f3.id, "unread-a", 300, 300);
      const b = await addItem(f3.id, "unread-b", 301, 301);
      const c = await addItem(f3.id, "unread-c", 302, 302);
      const query = { section: "kindling" as const, feedId: f3.id, showRead: false, deviceKey: "unread" };
      const first = await getReaderView(owner, query, { capture: false });
      assert.deepEqual(first.items.map(row => row.id), [c, b]);
      await mutateItems(owner, "read", [c, b]);
      const arrival = await addItem(f3.id, "unread-new", 303, 303);
      const next = await getReaderView(owner, { ...query, cursor: first.nextCursor! }, { capture: false });
      assert.deepEqual(next.items.map(row => row.id), [a]);
      assert.ok(!next.items.some(row => row.id === arrival));
    });

    await t.test("durable queue deduplicates, claims on separate workers and rejects stale job/feed fences", async () => {
      const context = { installationId: 1 as const, ownerId: owner.id };
      const [one, two] = await Promise.all([enqueueInstallationRefresh(context, { scope: "feed", id: f1.id, force: true }), enqueueInstallationRefresh(context, { scope: "feed", id: f1.id, force: true })]);
      assert.equal(one.id, two.id); assert.equal(one.totalFeeds, 1);
      const claimed = await Promise.all([claimJob(context, `${prefix}-worker-a`), claimJob(context, `${prefix}-worker-b`)]);
      assert.equal(claimed.filter(Boolean).length, 1);
      const job = claimed.find(Boolean)!;
      const feed = await claimFeed(job); assert.ok(feed); assert.equal(feed.feed.id, f1.id);
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await assertLease(client, job, feed); await client.query("COMMIT");
        await updateFeed(owner, { id: f1.id, url: `https://example.test/${prefix}/fence-changed.xml` });
        await client.query("BEGIN"); await assert.rejects(assertLease(client, job, feed), LostLeaseError); await client.query("ROLLBACK");
        await sql("UPDATE refresh_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
        const replacement = await claimJob(context, `${prefix}-replacement`); assert.ok(replacement); assert.ok(replacement.fence > job.fence);
        await client.query("BEGIN"); await assert.rejects(assertLease(client, job), LostLeaseError); await client.query("ROLLBACK");
      } finally { await client.query("ROLLBACK"); client.release(); }
    });

    await t.test("unsubscribe removes shared feeds and saved items while Spark subscriptions survive", async () => {
      await updateSparks(owner, { feedIds: [f2.id] });
      const savedBefore = Number((await sql("SELECT count(*) FROM items WHERE feed_id=$1 AND is_saved", [f1.id])).rows[0].count);
      await captureReaderView(owner, { section: "kindling", groupId: g1.id, feedId: f1.id, deviceKey: "delete" }, await getPreferences(owner));
      const result = await deleteGroup(owner, { id: g1.id, unsubscribe: true, confirm: true });
      assert.equal(result.feedsDeleted, 1); assert.equal(result.savedItemsDeleted, savedBefore);
      assert.equal((await sql("SELECT count(*)::int AS count FROM feeds WHERE id=$1", [f1.id])).rows[0].count, 0);
      assert.equal((await sql("SELECT count(*)::int AS count FROM feed_groups WHERE feed_id=$1", [f1.id])).rows[0].count, 0);
      assert.equal((await sql("SELECT count(*)::int AS count FROM items WHERE feed_id=$1", [f1.id])).rows[0].count, 0);
      assert.equal((await getNavigation(owner)).feeds.some(row => row.id === f2.id), true);
      const view = (await getViewState(owner, "delete")).view; assert.equal(view.feedId, 0); assert.equal(view.groupId, 0);
      assert.equal((await deleteSparks(owner, { confirm: true })).deleted, 1);
      assert.equal((await deleteFeed(owner, { id: f3.id, confirm: true })).deleted, 1);
      assert.equal((await getNavigation(owner)).feeds.length, 0);
    });

    await t.test("imported unsigned IDs reconcile sequences monotonically; connection transaction rollback is isolated", async () => {
      await sql("INSERT INTO groups(id,owner_id,title) VALUES(4294967295,1,$1)", [`${prefix} imported`]);
      const sequences = await reconcileSequences(operator);
      assert.ok(BigInt(sequences.groups.nextId) > 4294967295n);
      const created = await createGroup(owner, { title: `${prefix} post-import` }); assert.ok(created.id > 4294967295);
      const again = await reconcileSequences(operator); assert.ok(BigInt(again.groups.nextId) > BigInt(created.id));
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("UPDATE groups SET title='uncommitted' WHERE id=$1", [created.id]);
        assert.equal((await sql("SELECT title FROM groups WHERE id=$1", [created.id])).rows[0].title, `${prefix} post-import`);
        await client.query("ROLLBACK");
        assert.equal((await sql("SELECT title FROM groups WHERE id=$1", [created.id])).rows[0].title, `${prefix} post-import`);
      } finally { await client.query("ROLLBACK"); client.release(); }
    });
  } finally {
    try {
      if (ownsOwner) {
        // The owner was absent initially. A mismatched owner must never be removed.
        const deleted = await sql("DELETE FROM owner WHERE id=1 AND email=$1 RETURNING id", [owner.email]);
        assert.equal(deleted.rowCount, 1, "Fixture owner changed; installation status left untouched");
        await sql("UPDATE installation SET status=$1 WHERE id=1", [originalStatus]);
      }
    } finally {
      await operator.end().finally(closeDatabase);
    }
  }
});

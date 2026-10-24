import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { encode } from "next-auth/jwt";
import { closeDatabase, getDb, getPool } from "../lib/db/client";
import { groups, items } from "../lib/db/schema";
import { assertSchema, assertTarget, connectTarget } from "../lib/migration/target";
import { getOwner } from "../lib/auth/owner";
import { getAuthRuntime } from "../lib/auth/runtime";
import { revokeSessions } from "../lib/auth/account";
import { beginDomainMutation } from "../lib/domain/guard";
import { createFeed, createGroup, deleteFeed, deleteGroup, deleteSparks } from "../lib/domain/subscriptions";
import { captureReaderView, getPreferences, getViewState } from "../lib/domain/preferences";
import { getItem, getNavigation, getReaderView } from "../lib/domain/reader";
import { reapplyBlacklist, saveBlacklist } from "../lib/domain/blacklist";
import { cancelRefresh, enqueueRefresh } from "../lib/jobs";

const endpoint = "ep-silent-snow-aroq4quy.c-4.us-west-2.aws.neon.tech";
const fingerprint = "d3e876746c7f0a6b829a26d9a9384d2628c1fb2c630a4078ac25451b23d56d9b";

// Run database*.test.ts with --test-concurrency=1: fixtures deliberately enforce
// Fever's single-owner invariant rather than sharing mutable authentication state.
test("isolated PostgreSQL checked-session revocation and domain locking", { skip: process.env.FEVER_INTEGRATION_TESTS !== "1", timeout: 240_000 }, async (t) => {
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, endpoint, "Refusing a different database branch");
  const operator = await connectTarget(process.env.DATABASE_URL!);
  const pool = getPool();
  const owner = { id: 1, email: `integration-auth-${randomUUID()}@example.test` };
  const marker = `integration-auth-${randomUUID()}`;
  let ownsOwner = false;
  const unauthorized = (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === 401);
  const browserOwner = async () => {
    const epoch = Number((await pool.query("SELECT auth_epoch FROM owner WHERE id=1")).rows[0].auth_epoch);
    const runtime = getAuthRuntime();
    const token = await encode({ token: { sub: "1", email: owner.email, authEpoch: epoch,
      authenticatedUntil: Math.floor(Date.now() / 1000) + 300, installationUrl: runtime.baseUrl }, secret: runtime.secret, maxAge: 300 });
    const context = await getOwner(new Request(`${runtime.baseUrl}/`, { headers: { cookie: `${runtime.sessionCookieName}=${token}` } }));
    assert.ok(context, "Real encrypted JWT must resolve to a checked browser context");
    return context;
  };
  try {
    await assertTarget(operator, process.env.DATABASE_URL!, fingerprint);
    await assertSchema(operator);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM owner")).rows[0].count, 0, "Refusing an existing installation owner");
    assert.equal((await pool.query("SELECT status FROM installation WHERE id=1")).rows[0].status, "uninitialized");
    await pool.query("INSERT INTO owner(id,email,email_key,password_hash) VALUES(1,$1,$2,'integration-fixture-only')", [owner.email, owner.email]);
    ownsOwner = true;
    await pool.query("INSERT INTO reader_preferences(owner_id) VALUES(1)");
    await pool.query("UPDATE installation SET status='ready' WHERE id=1");
    const fixtureFeed = await createFeed(owner, { url: `https://example.test/${marker}/auth.xml` });
    const [fixtureItem] = await getDb().insert(items).values({ feedId: fixtureFeed.id, identityKey: marker,
      publishedAt: 1, addedAt: 1, title: "Authorization fixture" }).returning({ id: items.id });
    let jobId = 0;

    await t.test("checked browser readers work; revoked context cannot read, mutate, enqueue or cancel", async () => {
      const checked = await browserOwner();
      assert.equal((await getNavigation(checked)).feeds[0].id, fixtureFeed.id);
      assert.equal((await getReaderView(checked, { section: "kindling" }, { capture: false })).totalItems, 1);
      assert.equal((await getItem(checked, fixtureItem.id)).id, fixtureItem.id);
      const job = await enqueueRefresh(checked, { scope: "feed", id: fixtureFeed.id, force: true }); jobId = job.id;
      const beforeJob = (await pool.query("SELECT * FROM refresh_jobs WHERE id=$1", [jobId])).rows[0];
      await revokeSessions(owner);
      await assert.rejects(createGroup(checked, { title: `${marker} revoked` }), unauthorized);
      await assert.rejects(saveBlacklist(checked, "https://example.test/blocked"), unauthorized);
      await assert.rejects(reapplyBlacklist(checked), unauthorized);
      await assert.rejects(enqueueRefresh(checked, { scope: "feed", id: fixtureFeed.id, force: true }), unauthorized);
      await assert.rejects(cancelRefresh(checked, jobId), unauthorized);
      await assert.rejects(getNavigation(checked), unauthorized);
      await assert.rejects(getReaderView(checked, { section: "kindling" }, { capture: false }), unauthorized);
      await assert.rejects(getItem(checked, fixtureItem.id), unauthorized);
      assert.deepEqual((await pool.query("SELECT * FROM refresh_jobs WHERE id=$1", [jobId])).rows[0], beforeJob);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM groups")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT blacklist,version FROM reader_preferences WHERE owner_id=1")).rows[0].blacklist, "");
    });

    await t.test("recovery-required owner cannot mutate domain or blacklist even with current epoch", async () => {
      const checked = await browserOwner();
      await pool.query("UPDATE owner SET recovery_required=true WHERE id=1");
      try {
        await assert.rejects(createGroup(checked, { title: `${marker} recovery` }), unauthorized);
        await assert.rejects(saveBlacklist(checked, "https://example.test/blocked"), unauthorized);
        await assert.rejects(reapplyBlacklist(checked), unauthorized);
        await assert.rejects(enqueueRefresh(checked, { scope: "feed", id: fixtureFeed.id, force: true }), unauthorized);
        await assert.rejects(cancelRefresh(checked, jobId), unauthorized);
      } finally { await pool.query("UPDATE owner SET recovery_required=false WHERE id=1"); }
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM groups")).rows[0].count, 0);
    });

    await t.test("revocation waits for an authorized domain commit and then invalidates that context", async () => {
      const checked = await browserOwner();
      const beforeEpoch = Number((await pool.query("SELECT auth_epoch FROM owner WHERE id=1")).rows[0].auth_epoch);
      let held!: () => void; const lockHeld = new Promise<void>(resolve => { held = resolve; });
      let release!: () => void; const permitCommit = new Promise<void>(resolve => { release = resolve; });
      const domain = getDb().transaction(async tx => {
        await beginDomainMutation(tx, checked);
        held();
        await permitCommit;
        return (await tx.insert(groups).values({ ownerId: 1, title: marker }).returning({ id: groups.id }))[0].id;
      });
      // A rejection before the marker must not leave this test waiting forever.
      await Promise.race([lockHeld, domain.then(() => { throw new Error("Domain transaction committed before release"); })]);
      let revocationSettled = false;
      const revocation = revokeSessions(owner).finally(() => { revocationSettled = true; });
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          const activity = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'update \"owner\" set%'");
          if (activity.rows[0].count > 0) { waiting = true; break; }
          await delay(100);
        }
        assert.equal(waiting, true, "Observe the actual revocation UPDATE blocked by the owner SHARE lock");
        assert.equal(revocationSettled, false);
        assert.equal(Number((await pool.query("SELECT auth_epoch FROM owner WHERE id=1")).rows[0].auth_epoch), beforeEpoch);
      } finally {
        release();
        await Promise.allSettled([domain, revocation]);
      }
      const id = await domain;
      await revocation;
      assert.equal((await pool.query("SELECT title FROM groups WHERE id=$1", [id])).rows[0].title, marker);
      assert.equal(Number((await pool.query("SELECT auth_epoch FROM owner WHERE id=1")).rows[0].auth_epoch), beforeEpoch + 1);
      await assert.rejects(createGroup(checked, { title: `${marker} stale after wait` }), unauthorized);
    });

    await t.test("unsubscribe resets only removed device selections and cascades saved content", async () => {
      const removed = await createGroup(owner, { title: `${marker} removed` });
      const retained = await createGroup(owner, { title: `${marker} retained` });
      const feed = await createFeed(owner, { url: `https://example.test/${marker}/removed.xml`, groupIds: [removed.id, retained.id] });
      const spark = await createFeed(owner, { url: `https://example.test/${marker}/spark.xml`, groupIds: [removed.id], isSpark: true });
      const other = await createFeed(owner, { url: `https://example.test/${marker}/other.xml`, groupIds: [retained.id] });
      await getDb().insert(items).values({ feedId: feed.id, identityKey: marker, publishedAt: 1, addedAt: 1, isSaved: true });
      const preferences = await getPreferences(owner);
      await captureReaderView(owner, { section: "kindling", feedId: feed.id, groupId: removed.id, deviceKey: "removed" }, preferences);
      await captureReaderView(owner, { section: "kindling", feedId: feed.id, groupId: retained.id, deviceKey: "shared" }, preferences);
      await captureReaderView(owner, { section: "kindling", feedId: other.id, groupId: retained.id, deviceKey: "unrelated" }, preferences);
      const unrelated = (await pool.query("SELECT * FROM reader_view_state WHERE owner_id=1 AND device_id='unrelated'")).rows[0];
      const deleted = await deleteGroup(owner, { id: removed.id, unsubscribe: true, confirm: true });
      assert.equal(deleted.feedsDeleted, 1); assert.equal(deleted.savedItemsDeleted, 1);
      assert.equal((await getViewState(owner, "removed")).view.feedId, 0);
      assert.equal((await getViewState(owner, "removed")).view.groupId, 0);
      assert.equal((await getViewState(owner, "shared")).view.feedId, 0);
      assert.equal((await getViewState(owner, "shared")).view.groupId, retained.id);
      assert.deepEqual((await pool.query("SELECT * FROM reader_view_state WHERE owner_id=1 AND device_id='unrelated'")).rows[0], unrelated);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM items WHERE feed_id=$1", [feed.id])).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM feed_groups WHERE feed_id=$1", [feed.id])).rows[0].count, 0);
      assert.equal((await pool.query("SELECT id FROM feeds WHERE id=$1", [spark.id])).rowCount, 1);
      assert.equal((await deleteSparks(owner, { confirm: true })).deleted, 1);
      assert.equal((await deleteFeed(owner, { id: other.id, confirm: true })).deleted, 1);
      assert.equal((await getViewState(owner, "unrelated")).view.feedId, 0);
      assert.equal((await getViewState(owner, "unrelated")).view.groupId, retained.id);
    });
  } finally {
    try {
      if (ownsOwner) {
        assert.equal((await pool.query("DELETE FROM owner WHERE id=1 AND email=$1 RETURNING id", [owner.email])).rowCount, 1);
        await pool.query("UPDATE installation SET status='uninitialized' WHERE id=1");
      }
    } finally { await operator.end().finally(closeDatabase); }
  }
});

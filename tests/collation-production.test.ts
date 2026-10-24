import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { closeDatabase, getDb, getPool } from '../lib/db/client';
import { items } from '../lib/db/schema';
import { createFeed, createGroup, updateGroup } from '../lib/domain/subscriptions';
import { getNavigation, getReaderView } from '../lib/domain/reader';
import { assertSchema, assertTarget, connectTarget } from '../lib/migration/target';
import { DomainError } from '../lib/validation';

const enabled = process.env.FEVER_INTEGRATION_TESTS === '1';
const endpoint = 'ep-silent-snow-aroq4quy.c-4.us-west-2.aws.neon.tech';
const fingerprint = 'd3e876746c7f0a6b829a26d9a9384d2628c1fb2c630a4078ac25451b23d56d9b';

test('production reader search and group collisions use source comparison policies', { skip: !enabled, timeout: 180_000 }, async () => {
  assert.equal(process.versions.node.split('.')[0], '24');
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, endpoint, 'Refusing any other database branch');
  const operator = await connectTarget(process.env.DATABASE_URL!);
  const pool = getPool();
  const owner = { id: 1, email: `collation-${randomUUID()}@example.test` };
  let ownsOwner = false;
  try {
    await assertTarget(operator, process.env.DATABASE_URL!, fingerprint);
    await assertSchema(operator);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM owner')).rows[0].count, 0, 'Refusing an existing owner');
    assert.equal((await pool.query('SELECT status FROM installation WHERE id=1')).rows[0].status, 'uninitialized');
    await pool.query("INSERT INTO owner(id,email,email_key,password_hash) VALUES(1,$1,$2,'collation-fixture-only')", [owner.email, owner.email]);
    ownsOwner = true;
    await pool.query('INSERT INTO reader_preferences(owner_id) VALUES(1)');
    await pool.query("UPDATE installation SET status='ready' WHERE id=1");

    const angstrom = await createGroup(owner, { title: 'Ångström' });
    const cafe = await createGroup(owner, { title: 'Café' });
    const sharpS = await createGroup(owner, { title: 'Straße' });
    const zebra = await createGroup(owner, { title: 'Zebra' });
    const accentedReserved = await createGroup(owner, { title: 'Kíndling' });
    assert.equal(accentedReserved.created, true, 'The source built-in-name check is separate from SQL accent-insensitive group equality');
    assert.equal((await createGroup(owner, { title: 'Kindling' })).id, 0);
    for (const [title, id] of [['angstrom', angstrom.id], ['CAFE\u0301', cafe.id], ['STRASSE', sharpS.id]] as const) {
      const existing = await createGroup(owner, { title });
      assert.equal(existing.created, false);
      assert.equal(existing.id, id);
    }
    await assert.rejects(updateGroup(owner, { id: zebra.id, title: 'strasse' }), error => error instanceof DomainError && error.code === 'DUPLICATE_GROUP');
    assert.equal((await pool.query('SELECT title FROM groups WHERE id=$1', [zebra.id])).rows[0].title, 'Zebra');
    const imported = (await pool.query("INSERT INTO groups(owner_id,title) VALUES(1,'Duplicáte'),(1,'Duplicate'),(1,'Trailing ') RETURNING id,title")).rows;
    const trailing = await createGroup(owner, { title: 'Trailing' });
    assert.equal(trailing.created, false);
    assert.equal(String(trailing.id), imported[2].id);
    const navigation = await getNavigation(owner);
    assert.equal(navigation.groups.filter(group => ['Duplicáte', 'Duplicate'].includes(group.title)).length, 2, 'Imported equivalent group IDs remain separate');
    const ordered = navigation.groups.map(group => group.id);
    assert.ok(ordered.indexOf(angstrom.id) < ordered.indexOf(cafe.id));
    assert.ok(ordered.indexOf(cafe.id) < ordered.indexOf(sharpS.id));
    assert.ok(ordered.indexOf(sharpS.id) < ordered.indexOf(zebra.id));

    const feed = await createFeed(owner, { url: `https://fixture.test/${randomUUID()}`, title: 'Unread feed' });
    const rows = await getDb().insert(items).values(['CAFÉ', 'Straße', 'plain', 'e\u0301', '100% value'].map((title, index) => ({
      feedId: feed.id, identityKey: `collation-${index}`, title, rawHtml: '<p></p>', html: '<p></p>',
      url: `https://fixture.test/item-${index}`, canonicalUrl: `https://fixture.test/item-${index}`,
      publishedAt: 100 + index, addedAt: 100 + index,
    }))).returning({ id: items.id });
    const search = (value: string) => getReaderView(owner, { section: 'search', search: value, showRead: true, showFeeds: false, deviceKey: 'collation' }, { capture: false });
    for (const [value, expected] of [['cafe', [rows[0].id]], ['CAFÉ', [rows[0].id]], ['straße', [rows[1].id]], ['strasse', []], ['e\u0301', [rows[3].id]], ['\\', [rows[4].id]]] as const) {
      const result = await search(value);
      assert.deepEqual(result.items.map(item => item.id), expected, `Reader search ${JSON.stringify(value)}`);
      assert.equal(result.totalItems, expected.length);
      assert.equal(result.searchCounts?.['0'], expected.length);
      assert.deepEqual(result.visibleFeedIds, expected.length ? [feed.id] : []);
    }
  } finally {
    try {
      if (ownsOwner) {
        const deleted = await pool.query('DELETE FROM owner WHERE id=1 AND email=$1 RETURNING id', [owner.email]);
        assert.equal(deleted.rowCount, 1, 'Fixture owner changed; leaving installation status untouched');
        await pool.query("UPDATE installation SET status='uninitialized' WHERE id=1");
      }
    } finally { await operator.end().finally(closeDatabase); }
  }
});

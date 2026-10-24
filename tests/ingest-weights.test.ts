import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { persistLinkWeights } from '../lib/ingest/persist';
import { weightFeedLinks } from '../lib/ingest/links';
import { MAX_CRC32 } from '../lib/db/numbers';
import { assertTarget, closeTarget, connectTarget } from '../lib/migration/target';

type Write = { id: number; weight: number; isFirst: boolean };
function recordingClient() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return { calls, client: { query: async (text: string, values: unknown[]) => { calls.push({ text, values }); return { rowCount: 0, rows: [] }; } } as unknown as Pick<PoolClient, 'query'> };
}

test('feed weighting writes at most 1000 rows per parameterized statement and performs no empty write', async () => {
  const { calls, client } = recordingClient();
  await persistLinkWeights(client, 7, []);
  assert.equal(calls.length, 0);
  const links = Array.from({ length: 2501 }, (_, index) => ({ id: index + 1, weight: index % 23, isFirst: index % 3 === 0 }));
  await persistLinkWeights(client, 7, links);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => (call.values[0] as number[]).length), [1000, 1000, 501]);
  assert.deepEqual(calls.flatMap(call => call.values[0] as number[]), links.map(link => link.id));
  assert.deepEqual(calls.flatMap(call => call.values[1] as number[]), links.map(link => link.weight));
  assert.deepEqual(calls.flatMap(call => call.values[2] as boolean[]), links.map(link => link.isFirst));
  for (const call of calls) {
    assert.equal(call.values[3], 7);
    assert.match(call.text, /l\.feed_id=\$4/);
    assert.match(call.text, /l\.weight<>b\.weight OR l\.is_first<>b\.is_first/);
    assert.equal(call.values.length, 4);
  }
  const measured = recordingClient();
  await persistLinkWeights(measured.client, 7, links.slice(0, 201));
  assert.equal(measured.calls.length, 1, 'The measured 201-link feed requires one weight-update round trip');
});

test('exact integer and boolean boundaries fail before any chunk can write', async () => {
  const { calls, client } = recordingClient();
  const valid = { id: 1, weight: 0, isFirst: false };
  const invalid: Write[] = [
    { ...valid, id: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, id: 0 },
    { ...valid, weight: MAX_CRC32 + 1 }, { ...valid, weight: -1 }, { ...valid, weight: 0.5 },
    { ...valid, isFirst: 1 as unknown as boolean },
  ];
  for (const link of invalid) await assert.rejects(persistLinkWeights(client, 7, [...Array.from({ length: 1000 }, () => valid), link]));
  assert.equal(calls.length, 0);
  await persistLinkWeights(client, 7, [{ id: Number.MAX_SAFE_INTEGER, weight: MAX_CRC32, isFirst: true }]);
  assert.deepEqual(calls[0].values, [[Number.MAX_SAFE_INTEGER], [MAX_CRC32], [true], 7]);
});

test('a failed bulk chunk propagates to the owning transaction and stops subsequent writes', async () => {
  const failure = new Error('fixture write failure');
  let calls = 0;
  const client = { query: async () => { calls++; throw failure; } } as unknown as Pick<PoolClient, 'query'>;
  await assert.rejects(persistLinkWeights(client, 7, Array.from({ length: 1001 }, (_, index) => ({ id: index + 1, weight: 0, isFirst: false }))), error => error === failure);
  assert.equal(calls, 1);
});

test('PostgreSQL bulk weighting matches the former per-row SQL and leaves unchanged tuples and other feeds untouched', { skip: process.env.FEVER_WEIGHT_SQL_TESTS !== '1', timeout: 90_000 }, async t => {
  assert.equal(process.versions.node.split('.')[0], '24');
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, 'ep-green-cake-arly1cyb.c-4.us-west-2.aws.neon.tech', 'Refusing any other database branch');
  const client = await connectTarget(process.env.DATABASE_URL!);
  try {
    await assertTarget(client, process.env.DATABASE_URL!, 'c5ed350ed2e35b58e8f833c20c4b93b57a139533e145d351900121e147ea5945');
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE link_occurrences(id bigint PRIMARY KEY,feed_id bigint NOT NULL,weight bigint NOT NULL,is_first boolean NOT NULL,payload jsonb NOT NULL) ON COMMIT DROP`);
    const weighted = weightFeedLinks(Array.from({ length: 2501 }, (_, index) => ({
      id: index + 1, feedId: 7, canonicalUrl: `example.test/target/${index % 11}`, url: `https://example.test/target/${index % 11}`,
      isItem: index % 2 === 0, isLocal: index % 7 === 0, createdAt: 1000 + index % 17,
    })));
    const initial = weighted.map((link, index) => ({ ...link, weight: index % 3 === 0 ? link.weight : link.weight + 7, isFirst: index % 5 === 0 ? !link.isFirst : link.isFirst }));
    await client.query(`INSERT INTO link_occurrences SELECT id,7,weight,is_first,'{"retained":"payload"}'::jsonb FROM unnest($1::bigint[],$2::bigint[],$3::boolean[]) AS b(id,weight,is_first)`, [initial.map(link => link.id), initial.map(link => link.weight), initial.map(link => link.isFirst)]);
    await client.query(`INSERT INTO link_occurrences VALUES(9000,8,99,false,'{"other":"feed"}'::jsonb)`);
    await client.query('CREATE TEMP TABLE legacy_link_occurrences ON COMMIT DROP AS TABLE link_occurrences');
    await client.query(`CREATE TEMP TABLE desired_weights ON COMMIT DROP AS SELECT * FROM unnest($1::bigint[],$2::bigint[],$3::boolean[]) WITH ORDINALITY AS b(id,weight,is_first,position)`, [weighted.map(link => link.id), weighted.map(link => link.weight), weighted.map(link => link.isFirst)]);
    const before = new Map((await client.query('SELECT id,ctid::text AS tuple FROM link_occurrences')).rows.map(row => [row.id, row.tuple]));
    // Execute the exact former predicate inside PostgreSQL to avoid introducing
    // 2501 client round trips into a correctness comparison.
    await client.query(`DO $$ DECLARE link record; BEGIN FOR link IN SELECT * FROM desired_weights ORDER BY position LOOP
      UPDATE legacy_link_occurrences SET weight=link.weight,is_first=link.is_first WHERE id=link.id AND (weight<>link.weight OR is_first<>link.is_first);
      END LOOP; END $$`);
    const writes: number[] = [];
    const counted = { query: async (text: string, values: unknown[]) => { const result = await client.query(text, values); writes.push(result.rowCount ?? 0); return result; } } as unknown as Pick<PoolClient, 'query'>;
    await persistLinkWeights(counted, 7, weighted);
    const actual = (await client.query('SELECT id,feed_id,weight,is_first,payload FROM link_occurrences ORDER BY id')).rows;
    const legacy = (await client.query('SELECT id,feed_id,weight,is_first,payload FROM legacy_link_occurrences ORDER BY id')).rows;
    assert.deepEqual(actual, legacy);
    const unchanged = new Set(initial.filter((link, index) => link.weight === weighted[index].weight && link.isFirst === weighted[index].isFirst).map(link => String(link.id)));
    const after = (await client.query('SELECT id,ctid::text AS tuple FROM link_occurrences')).rows;
    for (const row of after) if (unchanged.has(row.id) || row.id === '9000') assert.equal(row.tuple, before.get(row.id), `Unchanged occurrence ${row.id} must not be rewritten`);
    assert.equal(writes.length, 3);
    assert.equal(writes.reduce((sum, count) => sum + count, 0), weighted.length - unchanged.size);
    await persistLinkWeights(client, 7, [{ id: 9000, weight: 1, isFirst: true }]);
    assert.deepEqual((await client.query('SELECT weight,is_first FROM link_occurrences WHERE id=9000')).rows[0], { weight: '99', is_first: false });
    t.diagnostic(JSON.stringify({ comparedRows: actual.length, weightedRows: weighted.length, updateStatements: writes.length, unchangedRows: unchanged.size, rewrittenRows: writes.reduce((sum, count) => sum + count, 0), otherFeedUnchanged: true }));
    await client.query('ROLLBACK');
  } finally {
    if (['T', 'E'].includes(client.getTransactionStatus() ?? '')) await client.query('ROLLBACK');
    await closeTarget(client);
  }
});

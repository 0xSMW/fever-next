import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { legacyFeedCompare, legacySortFeeds, legacyLike, legacyLikeRegex, legacyTextCompare, legacyTextEqual, legacyTitleKey } from '../lib/db/collation';
import { UCA400_DATA_SHA256, UCA400_PRIMARY_DATA } from '../lib/db/uca400-data';
import { oracle } from './hot-oracle';

const matches = (value: string, pattern: string) => new RegExp(legacyLikeRegex(pattern), 'su').test(value);

test('frozen Unicode 4 primary data retains its reviewed digest and source-sized table', () => {
  const data = gunzipSync(Buffer.from(UCA400_PRIMARY_DATA, 'base64'));
  assert.equal(createHash('sha256').update(data).digest('hex'), UCA400_DATA_SHA256);
  assert.equal(UCA400_DATA_SHA256, '4d16be9c598799602eec43b23b4bdf077120e7f49b6bece40cc0da1d7f013eaa');
  assert.equal(data.toString('ascii').split('\n').length, 12072);
});

test('title equality uses UCA4 expansions, primary ignorables and PAD SPACE without changing strings', () => {
  for (const [left, right] of [['café', 'CAFE'], ['Straße', 'STRASSE'], ['é', 'e\u0301'], ['Ångström', 'angstrom'], ['Trailing ', 'Trailing'], ['a\u00a0', 'a']]) {
    assert.equal(legacyTextEqual(left, right), true, `${left} = ${right}`);
    assert.equal(legacyTextCompare(left, right), 0);
  }
  assert.notEqual(legacyTitleKey('a'), legacyTitleKey('a\t'));
  assert.equal(legacyTextEqual('ẞ', 'ß'), false, 'capital sharp-S was not assigned in the source UCA4 table');
  assert.equal(legacyTextEqual('😀', '🚀'), false, 'new target-only supplementary names must stay distinct');
  assert.equal(legacyTextEqual('\ufdfa', 'صلى الله عليه وسلم'), false, 'MySQL UCA4 uses implicit weights for this long expansion');
});

test('ordering preserves MySQL NULL-first and PAD SPACE suffix comparisons', () => {
  assert.ok(legacyTextCompare(null, '') < 0);
  assert.equal(legacyTextCompare(null, null), 0);
  assert.ok(legacyTextCompare('a', 'a\t') > 0, 'missing suffix compares as space, which follows tab');
  assert.ok(legacyTextCompare('a', 'ab') < 0);
  assert.ok(legacyTextCompare('Ångström', 'zebra') < 0);
});

test('LIKE matching retains one-codepoint semantics instead of expanding input or normalizing strings', () => {
  assert.equal(matches('CAFÉ', '%cafe%'), true);
  assert.equal(matches('Ångström', '%angstrom%'), true);
  assert.equal(matches('Straße', '%strasse%'), false);
  assert.equal(matches('STRASSE', '%straße%'), false);
  assert.equal(matches('é', 'e\u0301'), false);
  assert.equal(matches('e\u0301', 'é'), false);
  assert.equal(matches('é', '_'), true);
  assert.equal(matches('e\u0301', '_'), false);
  assert.equal(matches('\n', '_'), true);
  assert.equal(matches('ไทย', '%ไทย%'), true);
});

test('LIKE wildcards and escapes cannot introduce regex syntax and expansion is bounded', () => {
  assert.equal(matches('anything', '%'), true);
  assert.equal(matches('aXb', 'a_b'), true);
  assert.equal(matches('100% value', String.raw`%\%%`), true);
  assert.equal(matches('100x value', String.raw`%\%%`), false);
  assert.equal(matches('back\\slash', String.raw`%\\%`), false, 'source post-% recursion loses the first escape');
  assert.equal(matches('100% value', String.raw`%\%`), true, 'source post-% escaped percent becomes recursive wildcard after its literal anchor');
  for (const value of ['a.*(b)+[c]', '^x$|.*', '[]-^\\']) {
    const literal = value.replace(/[\\%_]/g, '\\$&');
    assert.equal(matches(value, literal), true);
    assert.equal(matches('an unrelated value', literal), false);
  }
  assert.throws(() => legacyLikeRegex('%' + '\u0301'.repeat(2048) + '%'), /expands too far/);
  assert.throws(() => legacyLikeRegex('x'.repeat(2051)), /too long/);
  assert.throws(() => legacyLikeRegex('\0'), /unsupported/);
  const query = new PgDialect().sqlToQuery(legacyLike(sql.raw('title'), '%cafe%'));
  assert.match(query.sql, /title COLLATE "C"\) ~ \$1/);
  assert.equal(query.params.length, 1);
});

test('effective feed order uses source ASCII byte keys and source URL fallback', () => {
  const feeds = [
    { id: 2, title: 'Alpha', url: 'https://example.test/2' },
    { id: 10, title: 'alpha', url: 'https://example.test/10' },
    { id: 3, title: 'CAFÉ', url: 'https://example.test/3' },
    { id: 4, title: 'café', url: 'https://example.test/4' },
    { id: 5, title: '0', url: 'https://www.example.test/a/index.php' },
    { id: 6, title: null, url: 'https://www.example.test/b/' },
  ];
  assert.deepEqual(feeds.sort(legacyFeedCompare).map(feed => feed.id), [10, 2, 3, 4, 5, 6]);
  assert.ok(legacyFeedCompare({ id: 1, title: '2.', url: '' }, { id: 2, title: '10.', url: '' }) < 0);
});

test('mixed numeric PHP array keys follow the retained source ksort algorithm across partition sizes', () => {
  const titles = ['1', '2', '10', '0', '10a', '', '2.', '10.', '+2', '+10', '-2', '-10', '2e1', '1e2',
    '9007199254740991', '9007199254740992', '9223372036854775807', '9223372036854775808', null, 'ไทย'];
  for (const count of [2, 3, 4, 5, 6, 16, 17, 20, 200, 1100]) {
    const feeds = Array.from({ length: count }, (_, index) => ({ id: index + 1, title: titles[index % titles.length], url: `https://numeric.test/${index + 1}` }));
    assert.deepEqual(legacySortFeeds(feeds).map(feed => feed.id), oracle<number[]>('feed-order', { feeds }), `PHP source sort with ${count} entries`);
  }
});

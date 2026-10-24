import assert from 'node:assert/strict';
import test from 'node:test';
import iconv from 'iconv-lite';
import { parseFeed } from '../lib/ingest/parser';
import { FetchError } from '../lib/ingest/http';

const observedAt = 1_735_689_600;
const parse = (xml: string, maxItems = 100) => parseFeed(Buffer.from(xml), 'https://example.com/feed.xml', observedAt, undefined, maxItems);
const rss = (items: string) => `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Example &amp; Friends</title><link>https://example.com/</link>${items}</channel></rss>`;
const code = (expected: string) => (error: unknown) => error instanceof FetchError && error.code === expected;

test('RSS prefers full content, resolves links, sanitizes, and clamps future publication dates', () => {
  const feed = parse(rss('<item><guid isPermaLink="false">stable-1</guid><title>A &amp; B</title><author>reader@example.com (Reader)</author><link>/2024/12/01/story</link><description>Summary</description><content:encoded><![CDATA[<p>Full &amp; complete<script>hidden()</script><img src="/image.png"></p>]]></content:encoded><pubDate>Wed, 01 Jan 2030 00:00:00 GMT</pubDate></item>'));
  const item = feed.items[0];
  assert.equal(feed.title, 'Example & Friends');
  assert.equal(feed.siteUrl, 'https://example.com/');
  assert.equal(item.rawUid, 'stable-1');
  assert.equal(item.identityKind, 'uid');
  assert.equal(item.title, 'A & B');
  assert.equal(item.author, 'Reader');
  assert.equal(item.url, 'https://example.com/2024/12/01/story');
  assert.equal(item.publishedAt, observedAt);
  assert.match(item.rawHtml, /hidden/);
  assert.doesNotMatch(item.sanitizedHtml, /script|hidden/);
  assert.match(item.sanitizedHtml, /src="https:\/\/example.com\/image.png"/);
  assert.equal(item.searchText, 'A & B Reader Full & complete');
});

test('Atom XHTML inherits xml:base and stable identities survive content changes', () => {
  const atom = (body: string) => `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.com/blog/"><title>Atom</title><entry xml:base="posts/"><id>tag:example.com,2024:1</id><title>Entry</title><link href="one"/><author><name>Writer</name></author><content type="xhtml" xml:base="assets/"><div xmlns="http://www.w3.org/1999/xhtml"><p>${body}<a href="../source">Source</a></p></div></content></entry></feed>`;
  const first = parse(atom('First')).items[0];
  const second = parse(atom('Edited')).items[0];
  assert.equal(first.url, 'https://example.com/blog/posts/one');
  assert.match(first.sanitizedHtml, /href="https:\/\/example.com\/blog\/posts\/source"/);
  assert.equal(first.author, 'Writer');
  assert.equal(first.identityKey, second.identityKey);
  assert.notEqual(first.contentHash, second.contentHash);
});

test('RDF entries, charset declarations, text content, and bare ampersands are supported', () => {
  const xml = '<?xml version="1.0" encoding="windows-1252"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>Café & tea</title><link>https://example.com/</link></channel><item><title>Résumé</title><description><![CDATA[<p>Rock & roll</p>]]></description><link>https://example.com/2024/12/01/story</link></item></rdf:RDF>';
  const feed = parseFeed(iconv.encode(xml, 'windows-1252'), 'https://example.com/feed', observedAt);
  assert.equal(feed.title, 'Café & tea');
  assert.equal(feed.items[0].title, 'Résumé');
  assert.equal(feed.items[0].rawHtml, '<p>Rock & roll</p>');
  assert.equal(feed.items[0].publishedAt, Date.parse('2024-12-01T00:00:00Z') / 1000);
  const text = parse('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id><content type="text">&lt;script&gt;literal&lt;/script&gt;</content></entry></feed>').items[0];
  assert.equal(text.sanitizedHtml, '&lt;script&gt;literal&lt;/script&gt;');
});

test('identical duplicates collapse and conflicting stable identities are quarantined', () => {
  const item = '<item><guid isPermaLink="false">duplicate</guid><title>Same</title></item>';
  assert.equal(parse(rss(item + item)).items.length, 1);
  const conflict = parse(rss(item + item.replace('Same', 'Changed')));
  assert.equal(conflict.items.length, 0);
  assert.equal(conflict.quarantined.length, 2);
  assert.ok(conflict.quarantined.every(entry => entry.code === 'duplicate_identity'));
  assert.match(conflict.warnings.join(' '), /Conflicting duplicate/);
});

test('UID truncation preserves Unicode, distinct full IDs remain distinct, and fallback identity warns', () => {
  const uid = '😀'.repeat(80);
  const item = parse(rss(`<item><guid isPermaLink="false">${uid}</guid></item>`)).items[0];
  assert.ok(Buffer.byteLength(item.legacyUid) <= 255);
  assert.doesNotMatch(item.legacyUid, /�/);
  assert.notEqual(item.identityKey, parse(rss(`<item><guid isPermaLink="false">${uid}x</guid></item>`)).items[0].identityKey);
  const fallback = parse(rss('<item><title>Unlinked</title></item>'));
  assert.equal(fallback.items[0].identityKind, 'fingerprint');
  assert.match(fallback.warnings.join(' '), /fingerprint/);
});

test('same-link entries keep distinct IDs, origlink wins, missing titles/dates remain explicit, and GUIDs can be opaque', () => {
  const feed = parse('<rss xmlns:feedburner="http://rssnamespace.org/feedburner/ext/1.0"><channel><link>https://example.com/</link><item><guid isPermaLink="false">opaque-first</guid><link>https://tracking.example/story</link><feedburner:origLink>https://example.com/story</feedburner:origLink></item><item><guid isPermaLink="false">opaque-second</guid><link>https://example.com/story</link></item><item><guid isPermaLink="false">opaque-only</guid></item></channel></rss>');
  assert.equal(feed.items.length, 3);
  assert.equal(feed.items[0].url, 'https://example.com/story');
  assert.equal(feed.items[1].url, feed.items[0].url);
  assert.notEqual(feed.items[0].identityKey, feed.items[1].identityKey);
  assert.equal(feed.items[2].url, '');
  assert.equal(feed.items[2].title, '…');
  assert.equal(feed.items[2].publishedAt, 0);
});

test('UTF-16 BOM decoding and the legacy 100-entry default cap are preserved', () => {
  const xml = rss(Array.from({ length: 101 }, (_, index) => `<item><guid isPermaLink="false">${index}</guid><title>日本語 😀 ${index}</title></item>`).join(''));
  const feed = parseFeed(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(xml, 'utf-16le')]), 'https://example.com/feed', observedAt);
  assert.equal(feed.items.length, 100);
  assert.equal(feed.items[0].title, '日本語 😀 0');
  assert.equal(feed.items.at(-1)!.rawUid, '99');
  assert.match(feed.warnings.join(' '), /first 100 entries/);
});

test('parser rejects entities, malformed XML, unsupported roots, excessive nesting, and invalid limits', () => {
  assert.throws(() => parse('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'), code('xml_entity'));
  assert.throws(() => parse('<rss><channel></rss>'), code('invalid_xml'));
  assert.throws(() => parse('<html/>'), code('not_feed'));
  assert.throws(() => parse(`<rss>${'<x>'.repeat(64)}${'</x>'.repeat(64)}</rss>`), code('xml_limit'));
  assert.throws(() => parse(rss(''), 101), code('limits'));
  assert.throws(() => parseFeed(Buffer.from('<?xml version="1.0" encoding="no-such-codec"?><rss/>'), 'https://example.com'), code('xml_encoding'));
  const limited = parse(rss('<item><guid>a</guid></item><item><guid>b</guid></item>'), 1);
  assert.equal(limited.items.length, 1);
  assert.match(limited.warnings.join(' '), /first 1 entries/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { SaxesParser } from 'saxes';
import { feverXml } from '../lib/compat/serialize';
import { parseOpml } from '../lib/integrations/opml';
import { expandSharingTemplate } from '../lib/integrations/sharing';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
import { ROOT_QUERY_HEADER, rootCompatibilityRequest } from '../lib/http/root-compat';

test('root aliases retain query and POST semantics after rewrite query loss', async () => {
  for (const basePath of ['', '/fever']) {
    for (const api of ['api', 'api=', 'api=json', 'api=xml']) {
      const search = `?${api}&groups&feeds=&favicons=1&items&links&unread_item_ids&saved_item_ids&with_ids=&feed_ids=&group_ids=&tag=a%26b&tag=%E0%B9%84%E0%B8%97%E0%B8%A2&rss=saved&feedlet`;
      const body = 'api_key=test-only&mark=item&as=read&id=123&before=456';
      const incoming = new NextRequest(`https://reader.example${basePath}/${search}`, {
        method: 'POST', body, nextConfig: { basePath, trailingSlash: false },
        headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'reader.example', [ROOT_QUERY_HEADER]: '?api=xml&items=forged' },
      });
      const result = proxy(incoming);
      const destination = new URL(result.headers.get('x-middleware-rewrite')!);
      // NextURL keeps the prefixed root's existing trailing-slash policy.
      assert.equal(destination.pathname, `${basePath}/api/compat${basePath ? '/' : ''}`);
      assert.equal(destination.search, search);
      assert.equal(result.headers.get(`x-middleware-request-${ROOT_QUERY_HEADER}`), search);
      assert.equal(result.headers.has(ROOT_QUERY_HEADER), false, 'transport is upstream-only');
      assert.equal(incoming.bodyUsed, false, 'proxy must not consume the form');
      destination.search = ''; // Simulate query removal at the rewritten route boundary.
      const routed = new NextRequest(destination, {
        method: incoming.method, body: await incoming.text(),
        headers: { 'content-type': incoming.headers.get('content-type')!, host: 'reader.example', [ROOT_QUERY_HEADER]: result.headers.get(`x-middleware-request-${ROOT_QUERY_HEADER}`)! },
      });
      const restored = rootCompatibilityRequest(routed);
      assert.ok(restored instanceof NextRequest);
      assert.equal(new URL(restored.url).search, search);
      assert.deepEqual([...new URL(restored.url).searchParams], [...new URL(incoming.url).searchParams]);
      assert.equal(restored.headers.get('content-type'), incoming.headers.get('content-type'));
      assert.equal(restored.headers.has(ROOT_QUERY_HEADER), false);
      assert.equal(await restored.text(), body);
    }
    for (const path of ['/api/compat', '/api/compat?api=xml&items']) {
      const request = new NextRequest(`https://reader.example${basePath}${path}`, {
        nextConfig: { basePath, trailingSlash: false }, headers: { [ROOT_QUERY_HEADER]: '?api=xml&items=forged' },
      });
      const result = proxy(request);
      assert.equal(result.headers.get('x-middleware-next'), '1');
      assert.equal(result.headers.has(`x-middleware-request-${ROOT_QUERY_HEADER}`), false, 'direct routes cannot inject the transport');
      assert.equal(rootCompatibilityRequest(new Request(request.url)).url, request.url);
    }
    const rss = proxy(new NextRequest(`https://reader.example${basePath}/?rss=saved`, { nextConfig: { basePath, trailingSlash: false } }));
    assert.equal(new URL(rss.headers.get('x-middleware-rewrite')!).pathname, `${basePath}/rss/saved${basePath ? '/' : ''}`);
    assert.equal(rss.headers.has(`x-middleware-request-${ROOT_QUERY_HEADER}`), false);
  }
});

test('OPML decodes each XML entity once and preserves literal entity text in titles and feed URLs', () => {
  const preview = parseOpml('<opml><head><title>Literal &amp;amp; Title</title></head><body><outline text="Group &amp;lt; One"><outline text="Fish &amp;amp; Chips" xmlUrl="https://example.test/rss?a=1&amp;amp;b=2"/></outline></body></opml>', true);
  assert.equal(preview.title, 'Literal &amp; Title');
  assert.deepEqual(preview.groups, ['Group &lt; One']);
  assert.deepEqual(preview.feeds[0], { title: 'Fish &amp; Chips', url: 'https://example.test/rss?a=1&amp;b=2', group: 'Group &lt; One', isSpark: false });
  const flat = parseOpml('<opml><head><title>Literal &amp;amp; Title</title></head><body><outline text="Fish &amp;amp; Chips" xmlUrl="https://example.test/rss?a=1&amp;amp;b=2"/></body></opml>', false);
  assert.deepEqual(flat.groups, ['Literal &amp; Title (imported)']);
});

test('Fever XML emits valid escaped text for CDATA terminators, quotes, Unicode and control characters', () => {
  const input = 'before ]]> & <tag> "quote" \'single\' ไทย 🚀\u0000after';
  const xml = feverXml({ api_version: 3, auth: 1, items: [{ id: 1, html: input }], groups: [], unread_item_ids: '' });
  const parser = new SaxesParser({ xmlns: false });
  let inHtml = false, text = '';
  parser.on('opentag', tag => { inHtml = tag.name === 'html'; });
  parser.on('text', value => { if (inHtml) text += value; });
  parser.on('closetag', () => { inHtml = false; });
  parser.on('error', error => { throw error; });
  parser.write(xml).close();
  assert.equal(text, input.replace('\u0000', ''));
  assert.match(xml, /<items><item>/);
  assert.match(xml, /<groups><\/groups>/);
});

test('Fever XML distinguishes the source empty-result false from a real zero epoch', () => {
  assert.match(feverXml({ last_refreshed_on_time: false }), /<last_refreshed_on_time><\/last_refreshed_on_time>/);
  assert.match(feverXml({ last_refreshed_on_time: 0 }), /<last_refreshed_on_time>0<\/last_refreshed_on_time>/);
});

test('sharing substitutions preserve encoded title, URL and excerpt independently', () => {
  const item = { title: '%u & ไทย', url: 'https://example.test/?a=%t&b=2#fragment', excerpt: '%t <tag>\nnext' };
  const result = expandSharingTemplate({ name: 'Test', key: '', url: 'https://share.example.test/?title=%t&url=%u&excerpt=%e' }, item);
  const url = new URL(result.url);
  assert.equal(url.searchParams.get('title'), item.title);
  assert.equal(url.searchParams.get('url'), item.url);
  assert.equal(url.searchParams.get('excerpt'), item.excerpt);
  assert.equal(result.background, false);
});

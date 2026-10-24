import assert from 'node:assert/strict';
import test from 'node:test';
import { contentUrl, excerpt, plainText, sanitizeContent } from '../lib/ingest/content';
import { pageLinks } from '../lib/ingest/discovery';

test('content URLs resolve relative references while rejecting active schemes and credentials', () => {
  assert.equal(contentUrl('../photo.png', 'https://example.com/posts/one'), 'https://example.com/photo.png');
  assert.equal(contentUrl('#part', 'https://example.com', true), '#part');
  assert.equal(contentUrl('mailto:reader@example.com', undefined, true), 'mailto:reader@example.com');
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,a', 'https://user:pass@example.com/', 'https://example.com/\nsecret']) assert.equal(contentUrl(url, 'https://example.com'), undefined);
});

test('sanitization removes executable markup and constrains media, links, and dimensions', () => {
  const source = '<script>secret()</script><iframe>hidden</iframe><svg><text>svg</text></svg><p style="color:red" onclick="run()">Hello <a href="../story" target="_blank">story</a></p><img src="/safe.png" onerror="run()" width="5000" height="32"><img src="javascript:bad"><video src="movie.mp4" autoplay poster="/poster.png"></video>';
  const rich = sanitizeContent(source, 'rich', 'https://example.com/news/feed');
  assert.doesNotMatch(rich, /script|secret|iframe|hidden|svg|onclick|onerror|style=|autoplay|width="5000"|javascript:/);
  assert.match(rich, /href="https:\/\/example.com\/story" rel="noopener noreferrer"/);
  assert.match(rich, /src="https:\/\/example.com\/safe.png" height="32" loading="lazy" referrerpolicy="no-referrer"/);
  assert.match(rich, /<video[^>]*controls[^>]*preload="none"/);
  assert.doesNotMatch(sanitizeContent(source, 'text'), /<(?:img|video)\b/);
  assert.match(sanitizeContent(source, 'images', 'https://example.com'), /<img\b/);
  assert.doesNotMatch(sanitizeContent(source, 'images'), /<video\b/);
});

test('plain text and excerpts decode entities, preserve paragraph boundaries, and count Unicode characters', () => {
  assert.equal(plainText('<p>One &amp; two</p><p>Three<br>four</p><script>hidden</script>'), 'One & two Three four');
  assert.equal(excerpt('<p></p><p>First &amp; best.</p><p>Second.</p>'), 'First & best.');
  const shortened = excerpt(`<p>${'😀'.repeat(201)}</p>`);
  assert.equal(Array.from(shortened).length, 201);
  assert.equal(shortened, '😀'.repeat(200) + '…');
});

test('page discovery honors HTML base, deduplicates feeds, and rejects unsafe links', () => {
  const result = pageLinks('<title>A &amp; B</title><base href="https://example.com/blog/"><link rel="alternate" type="application/rss+xml" href="feed.xml"><link rel="alternate" type="application/rss+xml" href="feed.xml"><link rel="alternate" type="application/atom+xml" href="http://localhost/feed"><link rel="alternate" type="text/html" href="page"><link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">', 'https://example.com/');
  assert.deepEqual(result.feeds, [{ url: 'https://example.com/blog/feed.xml', title: 'A & B', type: 'application/rss+xml', subscribed: false, guessed: false }]);
  assert.deepEqual(result.icons, ['https://example.com/icon.png']);
});

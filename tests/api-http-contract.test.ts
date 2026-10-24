import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SaxesParser } from 'saxes';

// This suite talks to an explicitly running synthetic installation. It never
// logs in, changes account/settings data, or invokes a successful mutation.
const enabled = process.env.FEVER_HTTP_TESTS === '1';
const options = { skip: !enabled };
let base: URL;
let cookie: string;
let csrfToken: string;
let digest: string;

function url(path: string) { return new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base.origin); }
async function request(path: string, init: RequestInit = {}, authenticated = false) {
  const headers = new Headers(init.headers);
  if (authenticated) headers.set('Cookie', cookie);
  return fetch(url(path), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
}
function privateResponse(response: Response) {
  assert.match(response.headers.get('cache-control') ?? '', /(?:private|no-store)/);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}
async function jsonResponse(response: Response, status = 200) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /json/);
  privateResponse(response);
  return response.json();
}
async function errorResponse(response: Response, status: number, code?: string) {
  const data = await jsonResponse(response, status);
  assert.equal(typeof data.error, 'string');
  assert.equal(typeof data.code, 'string');
  if (code) assert.equal(data.code, code);
  assert.doesNotMatch(data.error, /(?:postgres(?:ql)?|password_hash|DATABASE_URL|stack trace)/i);
}
async function mutation(path: string, body: unknown, overrides: HeadersInit = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', Origin: base.origin, 'X-Fever-CSRF': csrfToken });
  new Headers(overrides).forEach((value, key) => headers.set(key, value));
  return request(path, { method: 'POST', headers, body: JSON.stringify(body) }, true);
}
async function fever(query: string, path = '/', form: URLSearchParams = new URLSearchParams({ api_key: digest })) {
  return request(`${path}?api&${query}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
}
function xmlTags(xml: string): string[] {
  const tags: string[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', tag => tags.push(tag.name));
  parser.on('error', error => { throw error; });
  parser.write(xml).close();
  return tags;
}

test.before(async () => {
  if (!enabled) return;
  base = new URL(process.env.FEVER_HTTP_BASE_URL ?? 'http://localhost:3000');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'HTTP tests require a localhost installation.');
  assert.equal(base.protocol, 'http:');
  assert.ok(!base.username && !base.password && !base.search && !base.hash);
  assert.match(base.pathname, /^\/(?:[A-Za-z0-9_-]+\/?)*$/);
  const storageFile = process.env.FEVER_HTTP_STORAGE_FILE;
  const credentialsFile = process.env.FEVER_HTTP_CREDENTIALS_FILE;
  assert.ok(storageFile && credentialsFile, 'Set private storage and credentials fixture paths.');
  const storage = JSON.parse(await readFile(storageFile, 'utf8')) as { cookies: Array<{ name: string; value: string; domain: string; path: string }> };
  cookie = storage.cookies.filter(value => value.domain === base.hostname && base.pathname.startsWith(value.path)).map(value => `${value.name}=${value.value}`).join('; ');
  assert.ok(cookie, 'The supplied storage has no installation cookies.');
  const credentials = JSON.parse(await readFile(credentialsFile, 'utf8')) as { email: string; password: string };
  assert.equal(typeof credentials.email, 'string');
  assert.equal(typeof credentials.password, 'string');
  digest = createHash('md5').update(credentials.email).update(':').update(credentials.password).digest('hex');
  const response = await request('/api/session', {}, true);
  const session = await jsonResponse(response);
  assert.equal(session.authenticated, true, 'The supplied synthetic browser session must already be authenticated.');
  assert.equal(typeof session.csrfToken, 'string');
  csrfToken = session.csrfToken;
  // A refreshed signed CSRF cookie belongs only to this test process.
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';', 1)[0];
    const name = pair.slice(0, pair.indexOf('='));
    cookie = cookie.split('; ').filter(existing => !existing.startsWith(`${name}=`)).concat(pair).join('; ');
  }
});

test('HTTP private read routes reject anonymous callers and remain uncached', options, async () => {
  for (const path of ['/api/reader?capture=0', '/api/feeds', '/api/items?feedId=1', '/api/items/1', '/api/refresh', '/api/diagnostics', '/api/opml/export', '/api/favicons/1', '/api/media?itemId=1&url=https%3A%2F%2Fexample.com%2Fimage.png']) {
    await errorResponse(await request(path), 401, 'UNAUTHENTICATED');
  }
});

test('HTTP mutation routes require authentication, same origin and signed CSRF', options, async () => {
  for (const path of ['/api/commands', '/api/feeds', '/api/subscribe', '/api/opml/import', '/api/discover', '/api/share']) {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base.origin }, body: '{}' };
    await errorResponse(await request(path, init), 401, 'UNAUTHENTICATED');
    await errorResponse(await request(path, init, true), 403, 'INVALID_CSRF');
    await errorResponse(await mutation(path, {}, { Origin: 'https://attacker.example' }), 403, 'INVALID_ORIGIN');
  }
});

test('HTTP JSON validation rejects malformed, scalar, unsupported and oversized command requests', options, async () => {
  const headers = { 'Content-Type': 'application/json', Origin: base.origin, 'X-Fever-CSRF': csrfToken };
  for (const body of ['{broken', 'null', '[]', '"scalar"']) await errorResponse(await request('/api/commands', { method: 'POST', headers, body }, true), 400, 'INVALID_REQUEST');
  await errorResponse(await request('/api/commands', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' }, true), 415, 'CONTENT_TYPE');
  await errorResponse(await mutation('/api/commands', { action: 'http.validation.unsupported', payload: {} }), 400, 'UNKNOWN_COMMAND');
  await errorResponse(await mutation('/api/commands', { action: 'http.validation.unsupported', payload: [] }), 400, 'INVALID_REQUEST');
  await errorResponse(await request('/api/commands', { method: 'POST', headers, body: ' '.repeat(1_048_577) }, true), 413, 'BODY_TOO_LARGE');
  assert.equal((await request('/api/commands', { method: 'GET' }, true)).status, 405);
});

test('HTTP reader validates malformed scope, page, boolean, cursor and item IDs', options, async () => {
  for (const query of ['section=unknown', 'page=0', 'page=1.5', 'feedId=-1', 'groupId=9007199254740992', 'showRead=yes', 'capture=maybe', 'deviceKey=bad%20key', `search=${'x'.repeat(1001)}`, 'section=kindling&cursor=not-a-cursor']) {
    const params = new URLSearchParams(query);
    if (!params.has('capture')) params.set('capture', '0');
    await errorResponse(await request(`/api/reader?${params}`, {}, true), 400);
  }
  for (const id of ['0', '-1', '1.5', '9007199254740992']) await errorResponse(await request(`/api/items/${id}`, {}, true), 400);
  await errorResponse(await request('/api/items?feedId=9007199254740991', {}, true), 404, 'FEED_NOT_FOUND');
  await errorResponse(await request('/api/refresh?id=0', {}, true), 400);
});

test('HTTP reader sections expose structured private results without capturing browser state', options, async () => {
  for (const section of ['hot', 'kindling', 'saved', 'sparks', 'search']) {
    const result = await jsonResponse(await request(`/api/reader?capture=0&deviceKey=http_contract&section=${section}&showRead=1&search=synthetic`, {}, true));
    assert.equal(result.view.section, section);
    assert.ok(Array.isArray(result.items));
    assert.ok(Array.isArray(result.links));
    assert.ok(Array.isArray(result.feeds));
    assert.equal(typeof result.hasMore, 'boolean');
    assert.equal(result.page, 1);
    assert.equal(result.nextCursor === null || typeof result.nextCursor === 'string', true);
  }
});

test('HTTP reader pagination and retained item adapters agree for a synthetic feed', options, async () => {
  const feeds = await jsonResponse(await request('/api/feeds', {}, true));
  assert.ok(feeds.length > 0, 'The synthetic fixture requires at least one feed.');
  const feed = feeds[0];
  const query = new URLSearchParams({ capture: '0', deviceKey: 'http_contract', section: feed.isSpark ? 'sparks' : 'kindling', feedId: String(feed.id), groupId: '0', showFeeds: '1', showRead: '1' });
  const first = await jsonResponse(await request(`/api/reader?${query}`, {}, true));
  const adapter = await jsonResponse(await request(`/api/items?feedId=${feed.id}&deviceKey=http_contract`, {}, true));
  assert.deepEqual(adapter.map((item: { id: number }) => item.id), first.items.map((item: { id: number }) => item.id));
  if (first.items.length) {
    const item = await jsonResponse(await request(`/api/items/${first.items[0].id}?deviceKey=http_contract`, {}, true));
    assert.equal(item.id, first.items[0].id);
    assert.equal(item.feedId, feed.id);
  }
  if (first.hasMore) {
    assert.equal(typeof first.nextCursor, 'string');
    query.set('cursor', first.nextCursor);
    const next = await jsonResponse(await request(`/api/reader?${query}`, {}, true));
    assert.equal(next.page, 2);
    const ids = new Set(first.items.map((item: { id: number }) => item.id));
    assert.ok(next.items.every((item: { id: number }) => !ids.has(item.id)));
    query.set('showRead', '0');
    await errorResponse(await request(`/api/reader?${query}`, {}, true), 400, 'INVALID_CURSOR');
  } else {
    assert.equal(first.nextCursor, null);
    query.set('page', '2');
    const next = await jsonResponse(await request(`/api/reader?${query}`, {}, true));
    assert.equal(next.page, 2);
    assert.deepEqual(next.items, []);
  }
});

test('HTTP Fever requires a form POST with a single digest and preserves JSON/XML auth envelopes', options, async () => {
  for (const path of ['/', '/api/fever']) {
    const anonymous = await jsonResponse(await request(`${path}?api&items`));
    assert.deepEqual(anonymous, { api_version: 3, auth: 0 });
    const invalid = await jsonResponse(await fever('items', path, new URLSearchParams({ api_key: 'invalid' })));
    assert.deepEqual(invalid, { api_version: 3, auth: 0 });
    const duplicate = await jsonResponse(await fever('items', path, new URLSearchParams([['api_key', digest], ['api_key', digest]])));
    assert.deepEqual(duplicate, { api_version: 3, auth: 0 });
    const jsonBody = await jsonResponse(await request(`${path}?api&items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    assert.deepEqual(jsonBody, { api_version: 3, auth: 0 });
    const xml = await request(`${path}?api=xml&items`);
    assert.equal(xml.status, 200);
    assert.match(xml.headers.get('content-type') ?? '', /text\/xml/);
    assert.deepEqual(xmlTags(await xml.text()), ['response', 'api_version', 'auth']);
  }
});

test('HTTP root dispatch recognizes bare, empty and valued flags with Fever priority', options, async () => {
  for (const flag of ['api', 'api=', 'api=json', 'api&rss=saved&feedlet']) {
    assert.deepEqual(await jsonResponse(await request(`/?${flag}`)), { api_version: 3, auth: 0 });
  }
  for (const suffix of ['', '=', '=1']) {
    for (const [flag, pathname] of [['subscribe', '/subscribe'], ['feedlet', '/feedlet']]) {
      const response = await request(`/?${flag}${suffix}&url=https%3A%2F%2Fexample.com%2Fpreview.xml`);
      assert.equal(response.status, 303);
      const location = new URL(response.headers.get('location')!);
      assert.equal(location.origin, base.origin);
      assert.equal(location.pathname, `${base.pathname.replace(/\/$/, '')}${pathname}`);
    }
    assert.equal((await request(`/?manifest${suffix}`)).status, 410);
  }
});

test('HTTP Fever combined reads preserve numeric IDs, flag types and complete CSV sets', options, async () => {
  for (const path of ['/', '/api/fever']) {
    const data = await jsonResponse(await fever('groups&feeds&favicons&items&links&unread_item_ids&saved_item_ids', path));
    assert.equal(data.api_version, 3);
    assert.equal(data.auth, 1);
    assert.equal(typeof data.last_refreshed_on_time, 'number');
    assert.equal(typeof data.total_items, 'number');
    assert.ok(data.items.length <= 50);
    for (const key of ['groups', 'feeds_groups', 'feeds', 'favicons', 'items', 'links']) assert.ok(Array.isArray(data[key]), key);
    for (const key of ['unread_item_ids', 'saved_item_ids']) assert.match(data[key], /^(?:[1-9]\d*(?:,[1-9]\d*)*)?$/);
    for (const item of data.items) {
      for (const key of ['id', 'feed_id', 'created_on_time']) assert.equal(Number.isSafeInteger(item[key]), true, key);
      for (const key of ['is_saved', 'is_read']) assert.ok(item[key] === 0 || item[key] === 1);
      assert.equal(typeof item.html, 'string');
      assert.doesNotMatch(item.html, /<script\b|\sonclick\s*=/i);
    }
    assert.deepEqual(data.items.map((item: { id: number }) => item.id), data.items.map((item: { id: number }) => item.id).sort((a: number, b: number) => a - b));
  }
  const xmlResponse = await request('/api/fever?api=xml&groups&feeds&favicons&items&links&unread_item_ids&saved_item_ids', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: digest }) });
  assert.equal(xmlResponse.status, 200);
  assert.match(xmlResponse.headers.get('content-type') ?? '', /xml/);
  const tags = xmlTags(await xmlResponse.text());
  for (const name of ['response', 'groups', 'feeds_groups', 'feeds', 'favicons', 'items', 'links', 'saved_item_ids']) assert.ok(tags.includes(name), name);
});

test('HTTP Fever selection honors strict boundaries, precedence, empty scopes and bounded input', options, async () => {
  const initial = await jsonResponse(await fever('items', '/api/fever'));
  assert.equal(initial.auth, 1);
  const ascending = initial.items.map((item: { id: number }) => item.id) as number[];
  const boundary = ascending[0] ?? 1;
  const after = await jsonResponse(await fever(`items&since_id=${boundary}`, '/api/fever'));
  assert.ok(after.items.every((item: { id: number }) => item.id > boundary));
  const newest = await jsonResponse(await fever('items&max_id=0&with_ids=0&since_id=9007199254740991', '/api/fever'));
  const descending = newest.items.map((item: { id: number }) => item.id) as number[];
  assert.deepEqual(descending, [...descending].sort((a, b) => b - a));
  const before = await jsonResponse(await fever(`items&max_id=${boundary}&with_ids=0&since_id=9007199254740991`, '/api/fever'));
  assert.ok(before.items.every((item: { id: number }) => item.id < boundary));
  const selected = await jsonResponse(await fever(`items&with_ids=${boundary}&since_id=9007199254740991`, '/api/fever'));
  assert.ok(selected.items.every((item: { id: number }) => item.id === boundary));
  for (const query of ['items&with_ids=', 'items&feed_ids=0', 'items&group_ids=0']) assert.deepEqual((await jsonResponse(await fever(query, '/api/fever'))).items, []);
  for (const query of ['items&since_id=-1', 'items&max_id=1.5', 'items&with_ids=1,NaN', 'links&range=0', 'links&page=0', 'items&since_id=9007199254740992']) {
    const data = await jsonResponse(await fever(query, '/api/fever'), 400);
    assert.equal(data.auth, 1);
    assert.equal(data.api_version, 3);
    assert.equal(data.code, 'INVALID_REQUEST');
  }
  await errorResponse(await fever('', '/api/fever', new URLSearchParams({ api_key: digest, padding: 'x'.repeat(65_536) })), 413, 'BODY_TOO_LARGE');
});

test('HTTP OPML export is XML with an attachment filename and import previews do not write', options, async () => {
  for (const query of ['', '?flatten=true&includeSparks=true', '?groupIds=0']) {
    const response = await request(`/api/opml/export${query}`, {}, true);
    assert.equal(response.status, 200);
    privateResponse(response);
    assert.match(response.headers.get('content-type') ?? '', /opml/);
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="fever[^"\r\n]*\.opml"$/);
    const tags = xmlTags(await response.text());
    assert.equal(tags[0], 'opml');
    assert.ok(tags.includes('head') && tags.includes('body'));
  }
  await errorResponse(await request('/api/opml/export?flatten=maybe', {}, true), 400);
  await errorResponse(await request('/api/opml/export?groupIds=9007199254740991', {}, true), 404, 'GROUP_NOT_FOUND');
  const preview = await jsonResponse(await mutation('/api/opml/import', { preview: true, importGroups: true, xml: '<?xml version="1.0"?><opml version="1.0"><head><title>HTTP Preview</title></head><body><outline text="Synthetic"><outline text="Example &amp; test" xmlUrl="https://example.com/preview-only.xml"/></outline></body></opml>' }));
  assert.equal(preview.title, 'HTTP Preview');
  assert.deepEqual(preview.groups, ['Synthetic']);
  assert.equal(preview.feeds[0].title, 'Example & test');
  for (const [xml, code] of [['<!DOCTYPE opml [<!ENTITY x SYSTEM "file:///etc/passwd">]><opml/>', 'UNSAFE_XML'], ['<opml><body>', 'INVALID_XML']]) await errorResponse(await mutation('/api/opml/import', { preview: true, importGroups: true, xml }), 400, code);
});

test('HTTP Saved RSS stays unavailable while publishing is off and root legacy GETs forward safely', options, async () => {
  for (const path of ['/rss/saved', '/?rss=saved']) await errorResponse(await request(path), 404, 'RSS_DISABLED');
  for (const [query, pathname] of [['subscribe&url=https%3A%2F%2Fexample.com%2Ffeed.xml', '/subscribe'], ['feedlet&url=https%3A%2F%2Fexample.com', '/feedlet']]) {
    const response = await request(`/?${query}`);
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get('location')!);
    assert.equal(location.origin, base.origin);
    assert.equal(location.pathname, `${base.pathname.replace(/\/$/, '')}${pathname}`);
    assert.equal(location.searchParams.get('url')?.startsWith('https://example.com'), true);
  }
  const manifest = await request('/?manifest');
  assert.equal(manifest.status, 410);
  assert.match(await manifest.text(), /NETWORK:\n\*/);
  const script = await request('/?feedlet&js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.match(await script.text(), /location\.assign/);
  await errorResponse(await request('/?manage=add-group', { method: 'POST', body: 'title=must-not-write' }, true), 409, 'LEGACY_FORM_REQUIRES_CONFIRMATION');
});

import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { FetchError, retryAfterSeconds, safeFetch, validateHttpUrl } from '../lib/ingest/http';

// The transport reads configuration lazily; no database is opened by these tests.
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1/unused_fixture';
Object.assign(process.env, { NODE_ENV: 'test' });
delete process.env.NEXTAUTH_URL;
delete process.env.NEXT_PUBLIC_BASE_PATH;
const hasCode = (code: string) => (error: unknown) => error instanceof FetchError && error.code === code;
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('URL validation rejects ambiguous addresses, credentials, control characters, and private names', () => {
  for (const url of ['file:///tmp/feed', 'https://user:pass@example.com/', 'https://example.com./', 'https://example.com/a b', 'https://example.com/\\secret']) assert.throws(() => validateHttpUrl(url), hasCode('invalid_url'));
  for (const url of ['http://127.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://localhost/', 'http://feed.internal/']) assert.throws(() => validateHttpUrl(url), hasCode('blocked_address'));
  assert.throws(() => validateHttpUrl('https://example.com:8443/'), hasCode('blocked_port'));
  assert.equal(validateHttpUrl('https://example.com/a#b').href, 'https://example.com/a');
  assert.equal(validateHttpUrl('http://localhost:8080/feed', ['http://localhost:8080']).href, 'http://localhost:8080/feed');
});

test('retry-after parsing handles seconds, HTTP dates, past dates, malformed values, and a one-day cap', () => {
  const now = Date.parse('2025-01-01T00:00:00Z');
  assert.equal(retryAfterSeconds('15', now), 15);
  assert.equal(retryAfterSeconds('Wed, 01 Jan 2025 00:00:02 GMT', now), 2);
  assert.equal(retryAfterSeconds('Tue, 31 Dec 2024 23:59:00 GMT', now), 0);
  assert.equal(retryAfterSeconds('999999999', now), 86_400);
  assert.equal(retryAfterSeconds('invalid', now), undefined);
  assert.equal(retryAfterSeconds(['10'], now), undefined);
});

test('transport refuses reserved IPs before opening a connection and validates limits', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]', '[::ffff:127.0.0.1]']) await assert.rejects(safeFetch(`http://${address}/`), hasCode('blocked_address'));
  await assert.rejects(safeFetch('https://example.com', { maxBytes: 0 }), hasCode('limits'));
  await assert.rejects(safeFetch('https://example.com', { maxRedirects: 5 }), hasCode('limits'));
});

test('conditional requests and credentials survive same-origin redirects and are removed across origins', async t => {
  const received: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
  const destination = await fixture((request, response) => { received.push({ path: request.url!, headers: request.headers }); response.end('destination'); });
  t.after(destination.close);
  const source = await fixture((request, response) => {
    received.push({ path: request.url!, headers: request.headers });
    if (request.url === '/cross') response.writeHead(302, { location: `${destination.origin}/final` }).end();
    else if (request.url === '/same') response.writeHead(302, { location: '/not-modified' }).end();
    else response.writeHead(304, { etag: 'new-etag' }).end();
  });
  t.after(source.close);
  const options = { privateOrigins: [source.origin, destination.origin], credentials: { username: 'reader', password: 'secret' }, etag: 'old-etag', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' };
  const same = await safeFetch(`${source.origin}/same`, options);
  assert.equal(same.status, 304);
  assert.equal(same.conditional, true);
  assert.equal(same.bytes.length, 0);
  assert.deepEqual(same.redirects, [`${source.origin}/not-modified`]);
  const sameHeaders = received.find(entry => entry.path === '/not-modified')!.headers;
  assert.equal(sameHeaders.authorization, 'Basic ' + Buffer.from('reader:secret').toString('base64'));
  assert.equal(sameHeaders['if-none-match'], 'old-etag');
  const cross = await safeFetch(`${source.origin}/cross`, options);
  assert.equal(cross.bytes.toString(), 'destination');
  assert.equal(cross.conditional, false);
  const finalHeaders = received.find(entry => entry.path === '/final')!.headers;
  assert.equal(finalHeaders.authorization, undefined);
  assert.equal(finalHeaders['if-none-match'], undefined);
  assert.equal(finalHeaders['if-modified-since'], undefined);
});

test('transport decodes gzip and bounds both compressed and expanded payloads', async t => {
  const fixtureServer = await fixture((request, response) => {
    if (request.url === '/encoding') { response.writeHead(200, { 'content-encoding': 'unknown' }).end('payload'); return; }
    if (request.url === '/advertised') { response.writeHead(200, { 'content-length': '10000' }).end('x'); return; }
    response.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(Buffer.from('a'.repeat(2048))));
  });
  t.after(fixtureServer.close);
  const options = { privateOrigins: [fixtureServer.origin] };
  assert.equal((await safeFetch(`${fixtureServer.origin}/gzip`, { ...options, maxBytes: 4096 })).bytes.length, 2048);
  await assert.rejects(safeFetch(`${fixtureServer.origin}/gzip`, { ...options, maxBytes: 1024 }), hasCode('too_large'));
  await assert.rejects(safeFetch(`${fixtureServer.origin}/advertised`, { ...options, maxCompressedBytes: 100 }), hasCode('too_large'));
  await assert.rejects(safeFetch(`${fixtureServer.origin}/encoding`, options), hasCode('encoding'));
});

test('redirect loops, rejected destinations, cancellation, and deadlines end bounded requests', async t => {
  const fixtureServer = await fixture((request, response) => {
    if (request.url === '/loop') response.writeHead(302, { location: '/loop' }).end();
    else if (request.url === '/private') response.writeHead(302, { location: 'http://169.254.169.254/' }).end();
    else { response.writeHead(200); response.flushHeaders(); }
  });
  t.after(fixtureServer.close);
  const options = { privateOrigins: [fixtureServer.origin] };
  await assert.rejects(safeFetch(`${fixtureServer.origin}/loop`, { ...options, maxRedirects: 0 }), hasCode('redirect'));
  await assert.rejects(safeFetch(`${fixtureServer.origin}/private`, options), hasCode('blocked_address'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(safeFetch(`${fixtureServer.origin}/hang`, { ...options, signal: controller.signal }), hasCode('cancelled'));
  await assert.rejects(safeFetch(`${fixtureServer.origin}/hang`, { ...options, deadlineMs: 50 }), hasCode('timeout'));
});

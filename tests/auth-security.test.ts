import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { AuthError } from '../lib/auth/errors';
import { getAuthRuntime, safeRedirect } from '../lib/auth/runtime';
import { assertCsrf, assertRequestPath, assertSameOrigin, constantTimeEqual, issueCsrfToken, normalizeLoginEmail, readBoundedBody, readCookie, readJsonBody, validateKeys, validateNewEmail } from '../lib/auth/security';

Object.assign(process.env, { NODE_ENV: 'test' });
process.env.FEVER_BASE_URL = 'https://reader.example/fever';
process.env.NEXT_PUBLIC_BASE_PATH = '/fever';
process.env.NEXTAUTH_URL = 'https://reader.example/fever/api/auth';
process.env.NEXTAUTH_SECRET = 'test-only-independent-secret-material-0123456789';
const owner = { id: 1, authEpoch: 4 };
const hasCode = (code: string) => (error: unknown) => error instanceof AuthError && error.code === code;
function request(options: { url?: string; origin?: string; referer?: string; site?: string; token?: string; cookie?: string } = {}) {
  const headers = new Headers({ origin: options.origin ?? 'https://reader.example' });
  if (options.referer) headers.set('referer', options.referer);
  if (options.site) headers.set('sec-fetch-site', options.site);
  if (options.token) headers.set('x-fever-csrf', options.token);
  if (options.cookie) headers.set('cookie', options.cookie);
  return new Request(options.url ?? 'https://reader.example/fever/api/account', { method: 'POST', headers });
}
function csrfRequest(token: string, options: Parameters<typeof request>[0] = {}) {
  return request({ token, cookie: `${getAuthRuntime().csrfCookieName}=${token}`, ...options });
}

test('runtime binds secure path-scoped cookie names to each canonical installation', () => {
  const first = getAuthRuntime();
  assert.equal(first.baseUrl, 'https://reader.example/fever');
  assert.equal(first.cookiePath, '/fever');
  assert.equal(first.secure, true);
  assert.match(first.sessionCookieName, /^__Secure-fever-[a-f0-9]{12}\.session-token$/);
  process.env.FEVER_BASE_URL = 'https://reader.example/other';
  process.env.NEXT_PUBLIC_BASE_PATH = '/other';
  process.env.NEXTAUTH_URL = 'https://reader.example/other/api/auth';
  try { assert.notEqual(getAuthRuntime().sessionCookieName, first.sessionCookieName); }
  finally {
    process.env.FEVER_BASE_URL = first.baseUrl;
    process.env.NEXT_PUBLIC_BASE_PATH = first.basePath;
    process.env.NEXTAUTH_URL = `${first.baseUrl}/api/auth`;
  }
});

test('redirects stay inside the canonical origin and installation path', () => {
  assert.equal(safeRedirect('/fever/hot?range=7#today'), 'https://reader.example/fever/hot?range=7#today');
  assert.equal(safeRedirect('saved'), 'https://reader.example/fever/saved');
  assert.equal(safeRedirect('/fever'), 'https://reader.example/fever');
  for (const value of ['https://evil.example/fever/', '//evil.example/', '/fever-other/', '/outside', '../outside', '/fever/%2foutside', '/fever/%5Coutside', '/fever/\\outside', '/fever/\npath', 'javascript:alert(1)']) {
    assert.equal(safeRedirect(value), 'https://reader.example/fever/', value);
  }
});

test('canonical request validation rejects origin, path-prefix, duplicate-separator and forwarding tricks', () => {
  assert.doesNotThrow(() => assertRequestPath(request()));
  for (const url of ['https://evil.example/fever/api', 'https://reader.example/fever-other/api', 'https://reader.example/fever//api', 'https://reader.example/fever/%2fapi', 'https://reader.example/fever/%5capi']) {
    assert.throws(() => assertRequestPath(request({ url })), hasCode('INVALID_ORIGIN'));
  }
  const forwarded = request({ url: 'https://evil.example/fever/api' });
  forwarded.headers.set('x-forwarded-host', 'reader.example');
  assert.throws(() => assertRequestPath(forwarded), hasCode('INVALID_ORIGIN'));
  for (const options of [{ origin: 'https://evil.example' }, { site: 'cross-site' }, { referer: 'https://reader.example/other/' }, { referer: 'invalid' }]) {
    assert.throws(() => assertSameOrigin(request(options)), hasCode('INVALID_ORIGIN'));
  }
  assert.doesNotThrow(() => assertSameOrigin(request({ referer: 'https://reader.example/fever/hot' })));
});

test('Next AppRoute normalized API requests retain origin, host and path protections under a base path', () => {
  const internal = (path: string, headers: Record<string, string> = {}) => new NextRequest(`https://reader.example${path}`, {
    headers: { host: 'reader.example', ...headers },
  });
  assert.doesNotThrow(() => assertRequestPath(internal('/api/session')));
  assert.doesNotThrow(() => assertRequestPath(internal('/api/auth/session')));
  assert.doesNotThrow(() => assertRequestPath(internal('/fever/api/session')));
  for (const path of ['/wrong/api/session', '/fever-other/api/session', '/api//session', '/api/%2fsession', '/api/%5csession']) {
    assert.throws(() => assertRequestPath(internal(path)), hasCode('INVALID_ORIGIN'));
  }
  assert.throws(() => assertRequestPath(internal('/api/session', { host: 'evil.example' })), hasCode('INVALID_ORIGIN'));
  assert.throws(() => assertRequestPath(new NextRequest('https://evil.example/api/session', {
    headers: { host: 'reader.example', 'x-forwarded-host': 'reader.example' },
  })), hasCode('INVALID_ORIGIN'));
  const forged = request({ url: 'https://reader.example/api/session' });
  forged.headers.set('x-forwarded-host', 'reader.example');
  forged.headers.set('x-forwarded-prefix', '/fever');
  assert.throws(() => assertRequestPath(forged), hasCode('INVALID_ORIGIN'));
  assert.throws(() => assertSameOrigin(new NextRequest('https://reader.example/api/session', {
    headers: { host: 'reader.example', origin: 'https://evil.example' },
  })), hasCode('INVALID_ORIGIN'));
});

test('CSRF requires signed matching cookie/header, canonical origin and current owner epoch', () => {
  const issued = issueCsrfToken(request(), owner);
  assert.match(issued.cookie, /; Path=\/fever; Max-Age=3600; HttpOnly; SameSite=Strict; Secure$/);
  assert.doesNotThrow(() => assertCsrf(csrfRequest(issued.token), owner));
  assert.equal(issueCsrfToken(csrfRequest(issued.token), owner).token, issued.token);
  assert.throws(() => assertCsrf(csrfRequest(issued.token), { ...owner, authEpoch: 5 }), hasCode('INVALID_CSRF'));
  assert.throws(() => assertCsrf(csrfRequest(issued.token), null), hasCode('INVALID_CSRF'));
  assert.throws(() => assertCsrf(request({ token: issued.token }), owner), hasCode('INVALID_CSRF'));
  assert.throws(() => assertCsrf(csrfRequest(issued.token, { token: issued.token.slice(0, -1) + 'x' }), owner), hasCode('INVALID_CSRF'));
  assert.throws(() => assertCsrf(csrfRequest(issued.token, { origin: 'https://evil.example' }), owner), hasCode('INVALID_ORIGIN'));
  const anonymous = issueCsrfToken(request(), null);
  assert.doesNotThrow(() => assertCsrf(csrfRequest(anonymous.token), null));
  assert.notEqual(issueCsrfToken(csrfRequest(issued.token), { ...owner, authEpoch: 5 }).token, issued.token);
});

test('CSRF expiry is fixed to one hour and future-dated tokens are refused', t => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const issued = issueCsrfToken(request(), owner);
  t.mock.method(Date, 'now', () => now + 3_599_000);
  assert.doesNotThrow(() => assertCsrf(csrfRequest(issued.token), owner));
  t.mock.method(Date, 'now', () => now + 3_600_000);
  assert.throws(() => assertCsrf(csrfRequest(issued.token), owner), hasCode('INVALID_CSRF'));
  t.mock.method(Date, 'now', () => now - 1000);
  assert.throws(() => assertCsrf(csrfRequest(issued.token), owner), hasCode('INVALID_CSRF'));
});

test('cookie parsing rejects duplicate cookies and malformed escapes', () => {
  assert.equal(readCookie(request({ cookie: 'unrelated=one; target=hello%20world' }), 'target'), 'hello world');
  assert.equal(readCookie(request({ cookie: 'target=one; target=two' }), 'target'), null);
  assert.equal(readCookie(request({ cookie: 'target=%FF' }), 'target'), null);
  assert.equal(readCookie(request({ cookie: 'target-other=value' }), 'target'), null);
  assert.equal(constantTimeEqual('é', 'é'), true);
  assert.equal(constantTimeEqual('é', 'e'), false);
});

test('JSON parsing enforces media type, byte budget, valid UTF-8 and object shape', async () => {
  const json = (body: string | Uint8Array, headers: Record<string, string> = {}) => new Request('https://reader.example/fever/api/account', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: typeof body === 'string' ? body : new Uint8Array(body).buffer,
  });
  assert.deepEqual(await readJsonBody(json('{"email":"a@b.com"}')), { email: 'a@b.com' });
  await assert.rejects(readJsonBody(json('{}', { 'content-type': 'text/plain' })), hasCode('UNSUPPORTED_MEDIA_TYPE'));
  for (const body of ['null', '[]', '"scalar"', '{broken']) await assert.rejects(readJsonBody(json(body)), hasCode('INVALID_INPUT'));
  await assert.rejects(readJsonBody(json(new Uint8Array([0xff]))), hasCode('INVALID_INPUT'));
  await assert.rejects(readJsonBody(json('"é"'), 3), hasCode('PAYLOAD_TOO_LARGE'));
  await assert.rejects(readBoundedBody(json('{}', { 'content-length': '100' }), 10), hasCode('PAYLOAD_TOO_LARGE'));
  await assert.rejects(readBoundedBody(json('{}', { 'content-length': 'NaN' }), 10), hasCode('PAYLOAD_TOO_LARGE'));
  assert.doesNotThrow(() => validateKeys({ email: 'a@b.com' }, ['email']));
  assert.throws(() => validateKeys({ passwordHash: 'injected' }, ['email']), hasCode('INVALID_INPUT'));
});

test('historical email lookup remains permissive while new email creation validates syntax', () => {
  assert.equal(normalizeLoginEmail(' Legacy@Example.COM '), 'legacy@example.com');
  assert.equal(normalizeLoginEmail('historical-login'), 'historical-login');
  assert.deepEqual(validateNewEmail(' Owner@Example.COM '), { email: 'Owner@Example.COM', emailKey: 'owner@example.com' });
  for (const value of ['historical-login', 'a@@b.com', 'a b@example.com']) assert.throws(() => validateNewEmail(value), hasCode('INVALID_INPUT'));
  for (const value of ['', 'a\nb@example.com', 'a'.repeat(321), null]) assert.throws(() => normalizeLoginEmail(value), hasCode('INVALID_INPUT'));
});

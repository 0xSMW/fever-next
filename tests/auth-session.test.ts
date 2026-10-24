import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from 'next-auth';
import { decode, encode, type JWT } from 'next-auth/jwt';
import { getAuthOptions } from '../lib/auth/options';
import { getAuthRuntime } from '../lib/auth/runtime';
import { defaultFaviconRecord } from '../lib/auth/default-favicon';

// This file exercises callback policy only. No accepted token reaches a DB query.
Object.assign(process.env, { NODE_ENV: 'test' });
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1/unused_auth_fixture';
process.env.FEVER_BASE_URL = 'https://reader.example/fever';
process.env.NEXT_PUBLIC_BASE_PATH = '/fever';
process.env.NEXTAUTH_URL = 'https://reader.example/fever/api/auth';
process.env.NEXTAUTH_SECRET = 'test-only-independent-secret-material-0123456789';
delete process.env.FEVER_SESSION_MAX_AGE_SECONDS;

test('NextAuth credentials sessions select JWT strategy and installation-scoped cookies', () => {
  const options = getAuthOptions();
  const runtime = getAuthRuntime();
  assert.deepEqual(options.session, { strategy: 'jwt', maxAge: 604800 });
  assert.deepEqual(options.jwt, { maxAge: 604800 });
  assert.equal(options.providers.length, 1);
  assert.equal(options.providers[0].type, 'credentials');
  assert.equal(options.cookies?.sessionToken?.name, runtime.sessionCookieName);
  for (const cookie of Object.values(options.cookies ?? {})) {
    assert.deepEqual(cookie?.options, { httpOnly: true, sameSite: 'lax', path: '/fever', secure: true });
  }
  assert.deepEqual(options.pages, { signIn: '/fever/login', error: '/fever/login' });
});

test('pinned NextAuth JWT codec encrypts claims and requires the matching secret', async () => {
  const secret = getAuthRuntime().secret;
  const token = { sub: '1', email: 'Owner@example.com', authEpoch: 4, installationUrl: getAuthRuntime().baseUrl };
  const encoded = await encode({ token, secret, maxAge: 300 });
  assert.equal(encoded.split('.').length, 5);
  assert.equal(encoded.includes(token.email), false);
  const decoded = await decode({ token: encoded, secret });
  assert.equal(decoded?.sub, token.sub);
  assert.equal(decoded?.authEpoch, token.authEpoch);
  assert.equal(decoded?.installationUrl, token.installationUrl);
  await assert.rejects(decode({ token: encoded, secret: 'a-different-test-only-secret-of-at-least-32-bytes' }));
});

test('session polling caps expiry at the original authentication deadline', async () => {
  const callback = getAuthOptions().callbacks!.session!;
  const token: JWT = { sub: '1', email: 'Owner@example.com', authenticatedUntil: 1_800_000_300 };
  const session: Session = { user: { id: '1', name: 'previous' }, expires: new Date(1_800_060_000_000).toISOString() };
  const params = { session, token } as Parameters<typeof callback>[0];
  const first = await callback(params);
  assert.deepEqual(first.user, { id: '1', email: 'Owner@example.com' });
  assert.equal(first.expires, '2027-01-15T08:05:00.000Z');
  assert.equal((await callback(params)).expires, first.expires);
  const earlier = await callback({ ...params, session: { ...session, expires: '2027-01-15T08:01:00.000Z' } });
  assert.equal(earlier.expires, '2027-01-15T08:01:00.000Z');
});

test('revoked and unidentified tokens cannot expose a session user', async () => {
  const callback = getAuthOptions().callbacks!.session!;
  for (const token of [{ sub: '1', revoked: true }, {}]) {
    const result = await callback({ session: { user: { id: '1', email: 'previous@example.com' }, expires: '2030-01-01T00:00:00.000Z' }, token } as Parameters<typeof callback>[0]);
    assert.equal(result.user, undefined);
  }
});

test('JWT policy revokes expired, wrong-installation, malformed owner and malformed epoch tokens before database access', async t => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  const callback = getAuthOptions().callbacks!.jwt!;
  const valid: JWT = { sub: '1', email: 'Owner@example.com', authEpoch: 4, authenticatedUntil: 1_800_000_300, installationUrl: 'https://reader.example/fever' };
  const tokens: JWT[] = [
    { ...valid, authenticatedUntil: 1_800_000_000 },
    { ...valid, authenticatedUntil: undefined },
    { ...valid, installationUrl: 'https://reader.example/other' },
    { ...valid, installationUrl: undefined },
    { ...valid, sub: '0' },
    { ...valid, sub: '1.5' },
    { ...valid, sub: '9007199254740992' },
    { ...valid, authEpoch: undefined },
    { ...valid, authEpoch: 1.5 },
  ];
  for (const token of tokens) {
    const result = await callback({ token } as Parameters<typeof callback>[0]);
    assert.equal(result.revoked, true);
    assert.equal(result.sub, undefined);
    assert.equal(result.email, undefined);
  }
});

test('default favicon record preserves the exact PHP fallback GIF and explicit owner/cache values', () => {
  // Frozen from firewall/app/libs/fever.php:add_default_favicon().
  const bytes = Buffer.from('R0lGODlhAQABAIAAAObm5gAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  const record = defaultFaviconRecord(7, 1_700_000_000);
  assert.equal(record.id, 1);
  assert.equal(record.ownerId, 7);
  assert.equal(record.url, 'favicon.png');
  assert.equal(record.mimeType, 'image/gif');
  assert.deepEqual(record.data, bytes);
  assert.equal(record.data.length, 43);
  assert.equal(record.contentHash, '3d53fa6213464a28b10f0abe3099889b3679efb0e84a8ce6c5d3d6be2559b69b');
  assert.equal(record.urlKey, 'c0df404f775f19f4b2853837cfb6270b3a71d706696f70e51cd493f2560277ee');
  assert.equal(record.cachedAt, 1_700_000_000);
  assert.equal(record.isDefault, true);
  for (const ownerId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => defaultFaviconRecord(ownerId, 1), TypeError);
  for (const time of [-1, 1.5, Number.NaN]) assert.throws(() => defaultFaviconRecord(1, time), TypeError);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, passwordHasSupportedSize, validateNewPassword, verifyPassword } from '../lib/auth/password';
import { feverDigestVerifier, verifierForFeverDigest } from '../lib/auth/fever';

// Independently derived with Node crypto.scryptSync, including invalid UTF-8 and NUL.
const importedBytes = Buffer.from([32, 255, 0, 195, 169, 32]);
const importedHash = 'scrypt$1$131072$8$1$00112233445566778899aabbccddeeff$1a7d1eb4d4adbb3616863cc8a4012cafea9ec49b63920aacb59097eefd250d8da4e529b487bc2bfafc7452170f883b344557f1e4ed9ceefdeaac6a2c320d6f12';

test('imported password verification preserves exact bytes and permits historical short passwords', async () => {
  assert.equal(await verifyPassword(importedBytes, importedHash), true);
  assert.equal(await verifyPassword(importedBytes.subarray(1, -1), importedHash), false);
  assert.equal(await verifyPassword(importedBytes.toString('utf8'), importedHash), false);
  const short = await hashPassword('x');
  assert.equal(await verifyPassword('x', short), true);
  assert.throws(() => validateNewPassword('x'));
});

test('new hashes have independent salts and preserve whitespace and Unicode normalization', async () => {
  const password = '  café password  ';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt\$1\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password.trim(), first), false);
  assert.equal(await verifyPassword(password.normalize('NFD'), first), false);
});

test('password limits count Unicode characters for minimum length and UTF-8 bytes for maximum length', async () => {
  assert.throws(() => validateNewPassword('😀'.repeat(11)));
  assert.doesNotThrow(() => validateNewPassword('😀'.repeat(12)));
  assert.doesNotThrow(() => validateNewPassword('é'.repeat(512)));
  assert.throws(() => validateNewPassword('é'.repeat(513)));
  assert.equal(passwordHasSupportedSize('é'.repeat(2048)), true);
  assert.equal(passwordHasSupportedSize('é'.repeat(2049)), false);
  for (const input of [null, undefined, 1, Buffer.from('password')]) assert.equal(passwordHasSupportedSize(input), false);
  await assert.rejects(hashPassword(Buffer.alloc(4097)), /supported byte limit/);
  assert.equal(await verifyPassword(Buffer.alloc(4097), importedHash), false);
});

test('stored hashes cannot select unreviewed scrypt work, malformed salts, keys, or encodings', async () => {
  const malformed = [
    importedHash.replace('$1$', '$2$'),
    importedHash.replace('$131072$', '$262144$'),
    importedHash.replace('$8$', '$16$'),
    importedHash.replace('$1$0011', '$2$0011'),
    importedHash.replace('$001122', '$gg1122'),
    importedHash.slice(0, -1),
    importedHash + '$extra',
    importedHash.toUpperCase(),
  ];
  for (const encoded of malformed) assert.equal(await verifyPassword(importedBytes, encoded), false);
});

test('password derivations reject overflow of the bounded execution queue and recover afterwards', async () => {
  // Two executing derivations plus eight queued requests are accepted per process.
  const work = Array.from({ length: 11 }, () => hashPassword('bounded queue fixture'));
  const results = await Promise.allSettled(work);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 10);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /temporarily busy/);
  assert.equal(await verifyPassword(importedBytes, importedHash), true);
});

test('Fever protocol verifier preserves original binary email/password bytes and accepts digest hex case', () => {
  const email = Buffer.from([65, 64, 255, 46, 99, 111, 109]);
  const expected = 'd41a8b449123f63738e25cf9f5c53c328df200bc9c5ec012b3a8d2d5187b0cf1';
  assert.equal(feverDigestVerifier(email, importedBytes), expected);
  assert.equal(verifierForFeverDigest('BEE5F92AC94636B9D7AA70FB4FF1F9AE'), expected);
  assert.notEqual(feverDigestVerifier(email.toString('utf8'), importedBytes), expected);
  assert.notEqual(feverDigestVerifier(email, importedBytes.subarray(1, -1)), expected);
  assert.notEqual(feverDigestVerifier('Owner@Example.com', 'password'), feverDigestVerifier('owner@example.com', 'password'));
  for (const value of ['', 'x'.repeat(32), '0'.repeat(31), '0'.repeat(33), ' ' + '0'.repeat(32)]) {
    assert.throws(() => verifierForFeverDigest(value), /Invalid Fever credential/);
  }
});

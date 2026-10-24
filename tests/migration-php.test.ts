import assert from "node:assert/strict";
import { test } from "node:test";
import { DecodeError, decodePhp, encodePhp, phpArray, phpObject, strictBase64, utf8 } from "../lib/migration/php";

const rejects = (input: string, code: string, options = {}) => assert.throws(() => decodePhp(Buffer.from(input), options), (error: unknown) => error instanceof DecodeError && error.code === code);

test("PHP strings preserve byte length, arbitrary bytes, quotes, delimiters and multibyte text", () => {
  const binary = Buffer.from([0, 255, 34, 59, 125]);
  const value = phpArray({ text: Buffer.from("ไทย 🚀 é"), binary, nested: { kind: "array", entries: [[0, true], [1, null], [2, -42], [3, 1.25]] } });
  const raw = encodePhp(value);
  assert.deepEqual(decodePhp(raw), value);
  assert.deepEqual(decodePhp(Buffer.from(raw.toString("base64"))), value);
  assert.deepEqual(phpObject(decodePhp(raw)).binary, binary);
  assert.equal(utf8(phpObject(decodePhp(raw)).text as Buffer), "ไทย 🚀 é");
  rejects('s:1:"é";', "INVALID_DELIMITER");
  assert.throws(() => utf8(binary));
  assert.throws(() => utf8(Buffer.from("a\0b")), /NUL_TEXT/);
});

test("base64 parsing rejects permissive Node decoding and noncanonical padding bits", () => {
  for (const input of ["YQ", "YQ==\n", "Y Q==", "YQ===", "!!!!"]) assert.throws(() => strictBase64(input), DecodeError);
  assert.throws(() => strictBase64("YR=="), /NONCANONICAL_BASE64/);
  assert.throws(() => strictBase64("YWJj", 2), DecodeError);
  assert.deepEqual(strictBase64(""), Buffer.alloc(0));
  assert.equal(strictBase64("YQ==").toString(), "a");
});

test("PHP grammar rejects executable/reference forms, malformed scalars, repeated keys and excess input", () => {
  for (const value of ['O:1:"X":0:{}', 'C:1:"X":0:{}', "R:1;", "r:1;"]) assert.throws(() => decodePhp(Buffer.from(value)), DecodeError);
  rejects("b:2;", "INVALID_BOOLEAN");
  rejects("i:9007199254740992;", "NUMBER_RANGE");
  rejects("d:INF;", "INVALID_NUMBER");
  rejects('s:100:"x";', "STRING_TRUNCATED");
  rejects('a:2:{i:0;N;i:0;N;}', "DUPLICATE_ARRAY_KEY");
  rejects('a:1:{b:1;N;}', "INVALID_ARRAY_KEY");
  rejects("N;N;", "TRAILING_BYTES");
  rejects("a:1:{i:0;N;}", "DEPTH_LIMIT", { maxDepth: 0 });
  rejects("a:1:{i:0;N;}", "ENTRY_LIMIT", { maxEntries: 2 });
  rejects("N;", "PAYLOAD_TOO_LARGE", { maxBytes: 1 });
  assert.throws(() => phpObject(decodePhp(Buffer.from("a:1:{i:0;N;}"))), /EXPECTED_STRING_KEY/);
  const object = phpObject(decodePhp(encodePhp(phpArray({ __proto__: null, constructor: Buffer.from("data") }))));
  assert.equal(Object.getPrototypeOf(object), null);
  assert.deepEqual(object.constructor, Buffer.from("data"));
});

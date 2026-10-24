import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { sanitizeImage } from '../lib/ingest/images';
import { FetchError } from '../lib/ingest/http';

const hasCode = (code: string) => (error: unknown) => error instanceof FetchError && error.code === code;

test('raster images are normalized to PNG, stripped of metadata, and bounded for favicons', async () => {
  const input = await sharp({ create: { width: 512, height: 256, channels: 3, background: '#ff3300' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'fixture secret' } } }).toBuffer();
  const safe = await sanitizeImage(input, 'https://example.com/icon.jpg', true);
  const metadata = await sharp(safe.bytes).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 64);
  assert.equal(metadata.exif, undefined);
  assert.equal(safe.mime, 'image/png');
  assert.equal(safe.url, 'https://example.com/icon.jpg');
  assert.equal(safe.hash, createHash('sha256').update(safe.bytes).digest('hex'));
});

test('small images are not enlarged and PNG payloads in ICO directories are supported', async () => {
  const png = await sharp({ create: { width: 2, height: 1, channels: 4, background: '#0088ffff' } }).png().toBuffer();
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(1, 4);
  directory[6] = 2; directory[7] = 1;
  directory.writeUInt16LE(1, 10); directory.writeUInt16LE(32, 12);
  directory.writeUInt32LE(png.length, 14); directory.writeUInt32LE(22, 18);
  const safe = await sanitizeImage(Buffer.concat([directory, png]), '', true);
  const metadata = await sharp(safe.bytes).metadata();
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 1);
});

test('uncompressed icon DIBs preserve pixel colors and AND-mask transparency', async () => {
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(1, 4);
  directory[6] = 2; directory[7] = 1;
  directory.writeUInt16LE(1, 10); directory.writeUInt16LE(24, 12);
  const dib = Buffer.alloc(52);
  dib.writeUInt32LE(40); dib.writeInt32LE(2, 4); dib.writeInt32LE(2, 8);
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(24, 14);
  dib.set([0, 0, 255, 0, 255, 0], 40); // red, green in BGR; 8-byte row stride
  dib[48] = 0b01000000; // second pixel transparent
  directory.writeUInt32LE(dib.length, 14); directory.writeUInt32LE(22, 18);
  const safe = await sanitizeImage(Buffer.concat([directory, dib]));
  assert.deepEqual([...await sharp(safe.bytes).ensureAlpha().raw().toBuffer()], [255, 0, 0, 255, 0, 255, 0, 0]);
});

test('documents, corrupt raster images, malformed icon directories, and oversized payloads are rejected', async () => {
  for (const input of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('<html>image</html>'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0, 0, 1, 0, 1, 0])]) await assert.rejects(sanitizeImage(input), hasCode('invalid_image'));
  await assert.rejects(sanitizeImage(Buffer.alloc(10 * 1024 * 1024 + 1)), hasCode('too_large'));
});

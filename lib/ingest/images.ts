import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { safeFetch, FetchError, type SafeFetchOptions } from './http';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export interface SafeImage { bytes: Buffer; mime: 'image/png'; url: string; hash: string; }
function raster(bytes: Buffer): 'ico' | 'image' | undefined {
  if (bytes.subarray(0, 8).equals(PNG) || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString('ascii')) || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')) return 'image';
  if (bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) return 'ico';
  return undefined;
}
/** Decode only bounded, uncompressed Windows icon DIBs; embedded PNGs use libvips. */
function iconSource(bytes: Buffer): { bytes: Buffer; raw?: { width: number; height: number; channels: 4 } } {
  const count = bytes.readUInt16LE(4);
  if (!count || count > 256 || 6 + count * 16 > bytes.length) throw new FetchError('invalid_image', 'The icon directory is invalid.');
  const entries = Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    return { width: bytes[offset] || 256, height: bytes[offset + 1] || 256, size: bytes.readUInt32LE(offset + 8), offset: bytes.readUInt32LE(offset + 12) };
  }).sort((a, b) => b.width * b.height - a.width * a.height);
  for (const entry of entries) {
    if (entry.offset < 6 + count * 16 || entry.size < 8 || entry.offset + entry.size > bytes.length) continue;
    const image = bytes.subarray(entry.offset, entry.offset + entry.size);
    if (image.subarray(0, 8).equals(PNG)) return { bytes: image };
    if (image.length < 40 || image.readUInt32LE(0) !== 40) continue;
    const width = image.readInt32LE(4); const doubledHeight = image.readInt32LE(8);
    const height = Math.abs(doubledHeight) / 2; const bits = image.readUInt16LE(14);
    if (width !== entry.width || height !== entry.height || image.readUInt16LE(12) !== 1 || image.readUInt32LE(16) !== 0 || ![8, 24, 32].includes(bits)) continue;
    const colors = bits === 8 ? image.readUInt32LE(32) || 256 : 0;
    if (colors > 256) continue;
    const start = 40 + colors * 4; const stride = Math.ceil(width * bits / 32) * 4; const maskStride = Math.ceil(width / 32) * 4;
    if (start + stride * height > image.length) continue;
    const output = Buffer.alloc(width * height * 4); let hasAlpha = false;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sourceY = doubledHeight > 0 ? height - y - 1 : y;
      const source = start + sourceY * stride + x * (bits / 8);
      const palette = bits === 8 ? 40 + image[source] * 4 : source;
      if (bits === 8 && image[source] >= colors) throw new FetchError('invalid_image', 'The icon palette is invalid.');
      const target = (y * width + x) * 4;
      output[target] = image[palette + 2]; output[target + 1] = image[palette + 1]; output[target + 2] = image[palette];
      output[target + 3] = bits === 32 ? image[source + 3] : 255;
      hasAlpha ||= bits === 32 && image[source + 3] !== 0;
    }
    const maskStart = start + stride * height;
    if (!hasAlpha) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sourceY = doubledHeight > 0 ? height - y - 1 : y;
      const maskOffset = maskStart + sourceY * maskStride + Math.floor(x / 8);
      output[(y * width + x) * 4 + 3] = maskOffset < image.length && (image[maskOffset] & (0x80 >> (x % 8))) ? 0 : 255;
    }
    return { bytes: output, raw: { width, height, channels: 4 } };
  }
  throw new FetchError('invalid_image', 'The icon has no supported safe image.');
}
export async function sanitizeImage(bytes: Buffer, url = '', favicon = false): Promise<SafeImage> {
  if (bytes.length > 10 * 1024 * 1024) throw new FetchError('too_large', 'The image exceeds the allowed size.');
  const kind = raster(bytes);
  if (!kind) throw new FetchError('invalid_image', 'Only supported raster images are allowed.');
  const input = kind === 'ico' ? iconSource(bytes) : { bytes, raw: undefined };
  try {
    const decoder = sharp(input.bytes, { ...(input.raw ? { raw: input.raw } : {}), limitInputPixels: 20_000_000, failOn: 'error', animated: false }).timeout({ seconds: 10 });
    const metadata = await decoder.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 20_000_000) throw new Error('dimensions');
    const output = await decoder.rotate().resize({ width: favicon ? 128 : 4096, height: favicon ? 128 : 4096, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    if (output.length > 10 * 1024 * 1024) throw new FetchError('too_large', 'The decoded image exceeds the allowed size.');
    return { bytes: output, mime: 'image/png', url, hash: createHash('sha256').update(output).digest('hex') };
  } catch (error) { if (error instanceof FetchError) throw error; throw new FetchError('invalid_image', 'The image could not be safely decoded.'); }
}
export async function fetchSafeImage(url: string, options: SafeFetchOptions & { favicon?: boolean } = {}): Promise<SafeImage> {
  const response = await safeFetch(url, { ...options, purpose: 'image', maxBytes: options.favicon ? 1024 * 1024 : 10 * 1024 * 1024, maxCompressedBytes: options.favicon ? 1024 * 1024 : 10 * 1024 * 1024 });
  if (response.status !== 200) throw new FetchError('image_http', `The image returned HTTP ${response.status}.`, response.status);
  if (/^(?:text\/|application\/(?:xml|xhtml|json))/i.test(response.headers['content-type'] ?? '')) throw new FetchError('invalid_image', 'The URL returned a document instead of an image.');
  return sanitizeImage(response.bytes, response.url, options.favicon);
}

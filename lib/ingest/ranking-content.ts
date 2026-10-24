import { parseDocument } from 'htmlparser2';
import { textContent } from 'domutils';
import { resolveLegacyUrl } from '../legacy-url';
const cp1252 = [8364,160,8218,402,8222,8230,8224,8225,710,8240,352,8249,338,160,381,160,160,8216,8217,8220,8221,8226,8211,8212,732,8482,353,8250,339,160,382,376];
function numeric(value: string, radix: number): string {
  let point = Number.parseInt(value, radix);
  if (point >= 128 && point < 160) point = cp1252[point - 128];
  return point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '�';
}
function decodeLegacy(value: string): string {
  return value.replace(/&#x0*([0-9a-f]+);/gi, (_, point: string) => numeric(point, 16))
    .replace(/&#0*([0-9]+);/g, (_, point: string) => numeric(point, 10))
    .replace(/&[a-zA-Z][a-zA-Z0-9]+;/g, entity => {
      if (entity === '&apos;') return entity; // PHP ENT_COMPAT does not decode single quotes.
      const decoded = textContent(parseDocument(entity));
      const chars = Array.from(decoded);
      return chars.length === 1 && (chars[0].codePointAt(0)! >= 160 && chars[0].codePointAt(0)! <= 255 || ['&quot;', '&amp;', '&lt;', '&gt;'].includes(entity)) ? decoded : entity;
    });
}
/**
 * fever.php parse_item + util.php html_entity_decode_utf8_pre. This derivative
 * is an untrusted compatibility input for Hot, never an HTML rendering policy.
 * Source pre/code blocks keep encoded entities; source link resolution uses
 * the feed site URL and the installation's HTTPS context, independently of
 * the standards-aware xml:base handling used by the safe rendering derivative.
 */
export function rankingContent(rawHtml: string, siteUrl: string, requestIsHttps = false): string {
  const unprefixed = rawHtml.replace(/<(\/?)html:/g, '<$1');
  const decoded = unprefixed.split(/(<pre[^>]*>[\s\S]*?<\/pre>|<code[^>]*>[\s\S]*?<\/code>)/g)
    .map((part, index) => index % 2 ? part : decodeLegacy(part)).join('');
  return decoded.replace(/(src|href)\s*=\s*(["'])([\s\S]*?)\2/gi, (_match, name: string, quote: string, target: string) => `${name}=${quote}${resolveLegacyUrl(siteUrl, target.trim(), requestIsHttps)}${quote}`);
}

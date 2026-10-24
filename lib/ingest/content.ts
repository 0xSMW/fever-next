import sanitizeHtml from 'sanitize-html';
import { parseDocument } from 'htmlparser2';
import { textContent } from 'domutils';

export const SANITIZER_VERSION = 1;
export type ContentMode = number | 'text' | 'images' | 'rich';
const textTags = ['p', 'br', 'hr', 'div', 'span', 'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'cite', 'code', 'dd', 'del', 'details', 'dfn', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'ins', 'kbd', 'li', 'mark', 'ol', 'pre', 'q', 's', 'samp', 'section', 'small', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tfoot', 'time', 'tr', 'u', 'ul', 'var', 'wbr'];
export function contentUrl(value: string, baseUrl?: string, allowMail = false): string | undefined {
  if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (allowMail && value.startsWith('#')) return value;
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:', ...(allowMail ? ['mailto:'] : [])].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}
export function sanitizeContent(html: string, mode: ContentMode = 'rich', baseUrl?: string): string {
  const images = mode === 1 || mode === 2 || mode === 'images' || mode === 'rich';
  const rich = mode === 2 || mode === 'rich';
  return sanitizeHtml(html, {
    allowedTags: [...textTags, ...(images ? ['img'] : []), ...(rich ? ['audio', 'video', 'source', 'track'] : [])],
    allowedAttributes: {
      '*': ['lang', 'dir', 'title'], a: ['href', 'rel'], img: ['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy'],
      td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'], ol: ['start', 'reversed'], li: ['value'],
      time: ['datetime'], details: ['open'], audio: ['src', 'controls', 'preload'], video: ['src', 'poster', 'controls', 'preload', 'width', 'height'], source: ['src', 'type'], track: ['src', 'kind', 'srclang', 'label'],
    },
    allowedSchemes: ['http', 'https', 'mailto'], allowedSchemesByTag: { img: ['http', 'https'], audio: ['http', 'https'], video: ['http', 'https'], source: ['http', 'https'], track: ['http', 'https'] },
    allowProtocolRelative: false, disallowedTagsMode: 'discard', enforceHtmlBoundary: true,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed', 'svg', 'math', 'template'],
    transformTags: { '*': (tagName, attributes) => {
      const attribs = { ...attributes };
      for (const name of ['href', 'src', 'poster']) {
        if (name in attribs) { const url = contentUrl(attribs[name], baseUrl, tagName === 'a' && name === 'href'); if (url) attribs[name] = url; else delete attribs[name]; }
      }
      for (const name of ['width', 'height', 'colspan', 'rowspan']) {
        if (name in attribs && (!/^\d{1,4}$/.test(attribs[name]) || Number(attribs[name]) > 4096)) delete attribs[name];
      }
      if (tagName === 'a') attribs.rel = 'noopener noreferrer';
      if (tagName === 'img') { attribs.loading = 'lazy'; attribs.referrerpolicy = 'no-referrer'; }
      if (tagName === 'video' || tagName === 'audio') { attribs.controls = ''; attribs.preload = 'none'; }
      return { tagName, attribs };
    } },
  });
}
export function plainText(html: string): string {
  const safe = sanitizeHtml(html, { allowedTags: ['p', 'br', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'], allowedAttributes: {}, nonTextTags: ['script', 'style', 'textarea', 'option', 'svg', 'math', 'template'] });
  return textContent(parseDocument(safe.replace(/<(?:br\s*\/?>|\/(?:p|div|li|h[1-6])>)/gi, ' '))).replace(/\s+/gu, ' ').trim();
}
/** Unicode-safe plain text, first nonempty paragraph, matching the legacy 200-character intent. */
export function excerpt(html: string): string {
  const safe = sanitizeContent(html, 'text');
  const first = safe.split(/<\/p>|(?:<br\s*\/?>\s*){2,}/i).map(part => plainText(part)).find(Boolean) ?? plainText(safe);
  const chars = Array.from(first);
  if (chars.length <= 200) return first;
  let value = chars.slice(0, 200).join('');
  const space = value.lastIndexOf(' ');
  if (space > 100) value = value.slice(0, space);
  return value.replace(/\.$/, '') + '…';
}

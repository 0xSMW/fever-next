import { createHash } from 'node:crypto';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import iconv from 'iconv-lite';
import { contentUrl, plainText, sanitizeContent, SANITIZER_VERSION } from './content';
import { FetchError } from './http';
import { checksum, resolveLegacyUrl } from '../legacy-url';

interface XmlNode { name: string; local: string; uri: string; attrs: Record<string, string>; base: string; parts: Array<string | XmlNode>; }
export interface ParsedItem {
  rawUid: string; legacyUid: string; identityKey: string; identityKind: 'uid' | 'url' | 'fingerprint'; sourceFingerprint: string;
  title: string; author: string; rawHtml: string; sanitizedHtml: string; sanitizerVersion: number; searchText: string;
  url: string; publishedAt: number; contentHash: string;
}
export interface ParsedFeed { title: string; siteUrl: string; items: ParsedItem[]; quarantined: Array<{code:string; item:ParsedItem}>; warnings: string[]; }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const children = (node: XmlNode) => node.parts.filter((part): part is XmlNode => typeof part !== 'string');
const nodeText = (node: XmlNode): string => node.parts.map(part => typeof part === 'string' ? part : nodeText(part)).join('');
function nodeMarkup(node: XmlNode): string {
  const name = node.local;
  const attrs = Object.entries(node.attrs).filter(([key]) => key !== 'xmlns' && !key.startsWith('xmlns:') && key !== 'xml:base').map(([key, value]) => ` ${key}="${xmlEscape(['href', 'src', 'poster'].includes(key) ? contentUrl(value, node.base, key === 'href') ?? value : value)}"`).join('');
  return `<${name}${attrs}>${node.parts.map(part => typeof part === 'string' ? xmlEscape(part) : nodeMarkup(part)).join('')}</${name}>`;
}
function content(node: XmlNode): string {
  if (node.attrs.type === 'xhtml' || children(node).length) return node.parts.map(part => typeof part === 'string' ? xmlEscape(part) : nodeMarkup(part)).join('');
  return node.attrs.type === 'text' ? xmlEscape(nodeText(node)) : nodeText(node);
}
function decodeXml(bytes: Buffer, contentType?: string): string {
  const leading = bytes.subarray(0, 256);
  let encoding = contentType?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes[0] === 0x00 && bytes[1] === 0x3c) encoding = 'utf-16be';
  else if (bytes[0] === 0x3c && bytes[1] === 0x00) encoding = 'utf-16le';
  const declaration = iconv.decode(leading, encoding || 'utf-8').match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i)?.[1];
  encoding = declaration || encoding || 'utf-8';
  if (!iconv.encodingExists(encoding)) throw new FetchError('xml_encoding', 'This feed declares an unsupported character encoding.');
  return iconv.decode(bytes, encoding).replace(/^\uFEFF/, '');
}
function parseXml(xml: string, url: string): XmlNode {
  if (xml.length > 8 * 1024 * 1024) throw new FetchError('too_large', 'The decoded feed exceeds the allowed size.');
  // Recover bare ampersands only in XML markup/text, never within preserved
  // CDATA or comments. No document type or user-declared entity is evaluated.
  const recovered = xml.split(/(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)/g).map((part,index) => {
    if (index % 2) return part;
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(part)) throw new FetchError('xml_entity', 'XML document types and entity declarations are not allowed.');
    return part.replace(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z_][\w.:-]*);)/gi, '&amp;');
  }).join('');
  const stack: XmlNode[] = []; let root: XmlNode | undefined; let count = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag: SaxesTagNS) => {
    if (++count > 100_000 || stack.length >= 64) throw new FetchError('xml_limit', 'The XML nesting or element limit was exceeded.');
    const attrs = Object.fromEntries(Object.values(tag.attributes).map(attribute => [attribute.name, attribute.value]));
    const parentBase = stack.at(-1)?.base ?? url;
    const base = attrs['xml:base'] ? contentUrl(attrs['xml:base'], parentBase) ?? parentBase : parentBase;
    const node: XmlNode = { name: tag.name.toLowerCase(), local: tag.local.toLowerCase(), uri: tag.uri, attrs, base, parts: [] };
    if (stack.length) stack.at(-1)!.parts.push(node); else root = node;
    stack.push(node);
  });
  parser.on('text', text => { stack.at(-1)?.parts.push(text); });
  parser.on('cdata', text => { stack.at(-1)?.parts.push(text); });
  parser.on('closetag', () => { stack.pop(); });
  parser.on('error', () => { throw new FetchError('invalid_xml', 'The feed contains invalid XML.'); });
  parser.write(recovered).close();
  if (!root) throw new FetchError('invalid_xml', 'The feed is empty.');
  return root;
}
function authorName(node: XmlNode): string {
  const nested = children(node).find(child => child.local === 'name');
  let name = plainText(nodeText(nested ?? node));
  name = name.replace(/^[^@]+@[^\(]+\(([^()]+).*/, '$1').replace(/^([^()]+)\([^)]*\)$/, '$1').replace(/\s+[^\s]+@[^\s]+$/, '').replace(/^([^@]+)@.*$/, '$1');
  return name.trim();
}
function publication(value: string): number {
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : 0;
}
export function parseFeed(bytes: Buffer, responseUrl: string, observedAt = Math.floor(Date.now() / 1000), contentType?: string, maxItems = 100): ParsedFeed {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new FetchError('limits', 'The feed entry limit must be between one and 100.');
  const root = parseXml(decodeXml(bytes, contentType), responseUrl);
  if (!['rss', 'feed', 'rdf'].includes(root.local)) throw new FetchError('not_feed', 'This document is not an RSS, Atom, or RDF feed.');
  const channel = children(root).find(node => node.local === 'channel') ?? root;
  let siteUrl = responseUrl;
  for (const node of children(channel)) {
    if (node.local === 'link' && (!node.attrs.rel || node.attrs.rel === 'alternate')) {
      const link = contentUrl(node.attrs.href || nodeText(node).trim(), node.base);
      if (link) { siteUrl = link; break; }
    }
  }
  const title = plainText(nodeText(children(channel).find(node => node.local === 'title') ?? { ...channel, parts: [] }));
  const nodes = [...children(channel).filter(node => node.local === 'entry' || node.local === 'item'), ...(root.local === 'rdf' ? children(root).filter(node => node.local === 'item') : [])];
  if (nodes.length > 10_000) throw new FetchError('xml_limit', 'The feed contains too many entries.');
  const warnings: string[] = [];
  if (nodes.length > maxItems) warnings.push(`Only the first ${maxItems} entries are processed; the configured limit cannot exceed the legacy 100-entry cap.`);
  const result: ParsedItem[] = [];
  for (const node of nodes.slice(0, maxItems)) {
    let itemTitle = ''; let author = ''; let rawHtml = ''; let htmlBase = node.base; let link = ''; let originalLink = ''; let sourceLink = ''; let sourceOriginalLink = ''; let rawUid = ''; let publishedAt = 0; let permalink = true; let fullContent = false;
    for (const part of children(node)) {
      if (part.local === 'title') itemTitle = plainText(nodeText(part));
      if (['author', 'creator', 'credit'].includes(part.local)) author = authorName(part);
      if (['description', 'content', 'encoded', 'summary'].includes(part.local)) {
        const full = part.local === 'content' || part.local === 'encoded';
        if (full || !fullContent) { const candidate = content(part); if (candidate) { rawHtml = candidate; htmlBase = part.base; fullContent = full; } }
      }
      if (part.local === 'origlink') { sourceOriginalLink = nodeText(part).trim(); originalLink = contentUrl(sourceOriginalLink, part.base) ?? ''; }
      if (part.local === 'link' && !link && (!part.attrs.rel || part.attrs.rel === 'alternate')) { sourceLink = part.attrs.href || nodeText(part).trim(); link = contentUrl(sourceLink, part.base) ?? ''; }
      if (['pubdate', 'published', 'updated', 'issued', 'modified', 'created', 'date'].includes(part.local)) publishedAt = publication(nodeText(part));
      if (part.local === 'guid' || part.local === 'id') { rawUid = nodeText(part).trim(); permalink = part.attrs.isPermaLink !== 'false' && part.local !== 'id'; }
    }
    link = originalLink || link || (permalink ? contentUrl(rawUid, node.base) ?? '' : '');
    const legacyBase = node.attrs['xml:base'] ? resolveLegacyUrl(siteUrl, node.attrs['xml:base']) : siteUrl;
    const legacyLink = sourceOriginalLink || sourceLink || (permalink ? rawUid : '');
    const legacyUrl = legacyLink ? resolveLegacyUrl(legacyBase, legacyLink) : '';
    if (!publishedAt && link) { const date = link.match(/\b(\d{4})\/(\d{2})\/(\d{2})\b/); if (date) publishedAt = publication(`${date[1]}-${date[2]}-${date[3]}T00:00:00Z`); }
    publishedAt = Math.min(publishedAt, observedAt);
    const sanitizedHtml = sanitizeContent(rawHtml, 'rich', htmlBase);
    const sourceFingerprint = hash(JSON.stringify([rawUid, itemTitle, author, rawHtml, link]));
    const identityKind = rawUid ? 'uid' : link ? 'url' : 'fingerprint';
    const identityKey = hash(`${identityKind}:v1:${rawUid || link || JSON.stringify([itemTitle, author, rawHtml])}`);
    if (identityKind === 'fingerprint') warnings.push('An entry without a stable ID or link uses a content fingerprint; publisher edits may create a new entry.');
    result.push({ rawUid, legacyUid: rawUid ? Buffer.from(rawUid, 'utf8').subarray(0, 255).toString('utf8').replace(/\uFFFD$/, '') : legacyUrl ? String(checksum(legacyUrl)) : '', identityKey, identityKind, sourceFingerprint, title: itemTitle || '…', author, rawHtml, sanitizedHtml, sanitizerVersion: SANITIZER_VERSION, searchText: plainText(`${itemTitle} ${author} ${rawHtml}`), url: link, publishedAt, contentHash: hash(JSON.stringify([itemTitle, author, rawHtml, sanitizedHtml, link, SANITIZER_VERSION])) });
  }
  const grouped = new Map<string, ParsedItem[]>();
  for (const item of result) { const group = grouped.get(item.identityKey) ?? []; group.push(item); grouped.set(item.identityKey, group); }
  const items: ParsedItem[] = [];
  const quarantined: Array<{code:string; item:ParsedItem}> = [];
  for (const group of grouped.values()) {
    if (new Set(group.map(item => item.sourceFingerprint)).size > 1) {
      warnings.push(`Conflicting duplicate entry identity ${group[0].identityKey} was skipped for review.`);
      for (const item of group) quarantined.push({ code: 'duplicate_identity', item });
    }
    else items.push(group[0]);
  }
  return { title, siteUrl, items, quarantined, warnings: [...new Set(warnings)] };
}

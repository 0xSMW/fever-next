import { parseDocument } from 'htmlparser2';
import { getElementsByTagName, textContent } from 'domutils';
import { getConfig } from '../config';
import type { FeedCandidate } from '../contracts';
import { safeFetch, FetchError, validateHttpUrl, type SafeFetchOptions } from './http';
import { parseFeed } from './parser';
import { contentUrl, plainText } from './content';

export function pageLinks(html: string, responseUrl: string, privateOrigins: readonly string[] = []): { feeds: FeedCandidate[]; icons: string[] } {
  const document = parseDocument(html);
  const baseTag = getElementsByTagName('base', document.children, true, 1)[0];
  const base = contentUrl(baseTag?.attribs.href ?? '', responseUrl) ?? responseUrl;
  const titleNode = getElementsByTagName('title', document.children, true, 1)[0];
  const pageTitle = titleNode ? plainText(textContent(titleNode)) : new URL(responseUrl).hostname;
  const feeds: FeedCandidate[] = []; const icons: string[] = [];
  for (const node of getElementsByTagName('link', document.children, true)) {
    const rel = (node.attribs.rel ?? '').toLowerCase().split(/\s+/);
    const type = (node.attribs.type ?? '').toLowerCase().split(';')[0];
    const href = contentUrl(node.attribs.href ?? '', base);
    if (!href) continue;
    try { validateHttpUrl(href, privateOrigins); } catch { continue; }
    if (rel.includes('alternate') && ['application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/xml', 'text/xml'].includes(type)) {
      feeds.push({ url: href, title: plainText(node.attribs.title || pageTitle), type, subscribed: false, guessed: false });
    }
    if (rel.includes('icon') || rel.includes('apple-touch-icon')) icons.push(href);
  }
  return { feeds: [...new Map(feeds.map(feed => [feed.url, feed])).values()].slice(0, 32), icons: [...new Set(icons)].slice(0, 8) };
}
export async function discoverFeeds(input: string): Promise<FeedCandidate[]> {
  const url = input.startsWith('feed://') ? input.replace(/^feed:\/\//, 'http://') : input;
  const response = await safeFetch(url, { purpose: 'discovery' });
  if (response.status < 200 || response.status >= 300) throw new FetchError(response.status === 401 ? 'requires_auth' : 'http', response.status === 401 ? 'This feed requires credentials. Add its URL using the protected-feed fields.' : `Discovery returned HTTP ${response.status}.`, response.status);
  const type = String(response.headers['content-type'] ?? '').split(';')[0].toLowerCase();
  if (!['', 'application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'text/html', 'application/xhtml+xml', 'text/plain', 'application/octet-stream'].includes(type)) throw new FetchError('content_type', 'The URL did not return a feed or web page.');
  const appearsHtml = /<!doctype\s+html|<html[\s>]/i.test(response.bytes.subarray(0,2048).toString('utf8'));
  try {
    if (appearsHtml) throw new FetchError('not_feed', 'This document is a web page.');
    const feed = parseFeed(response.bytes, response.url, undefined, response.headers['content-type']);
    return [{ url: response.url, title: feed.title, type: type || 'application/xml', subscribed: false, guessed: false }];
  } catch (error) {
    if (!(error instanceof FetchError) || !['not_feed', 'invalid_xml'].includes(error.code)) throw error;
    if (!['text/html', 'application/xhtml+xml', '', 'text/plain', 'application/octet-stream'].includes(type)) throw error;
  }
  const discovered = pageLinks(response.bytes.toString('utf8'), response.url, getConfig().allowedPrivateOrigins).feeds;
  if (discovered.length) return discovered;
  // Guesses are verified with the same bounded transport before being offered.
  const guesses = ['/feed/', '/rss.xml', '/atom.xml'];
  const results: FeedCandidate[] = [];
  for (const path of guesses) {
    try {
      const candidate = await safeFetch(new URL(path, response.url).href, { purpose: 'feed', deadlineMs: 12_000 });
      if (candidate.status !== 200) continue;
      const feed = parseFeed(candidate.bytes, candidate.url, undefined, candidate.headers['content-type']);
      results.push({ url: candidate.url, title: feed.title, type: String(candidate.headers['content-type'] ?? 'application/xml').split(';')[0], subscribed: false, guessed: true });
    } catch { /* An unavailable conventional feed URL is not a discovered feed. */ }
  }
  return [...new Map(results.map(candidate => [candidate.url, candidate])).values()];
}
export async function discoverIconUrls(siteUrl: string, options: SafeFetchOptions = {}): Promise<string[]> {
  const fallback = new URL('/favicon.ico', validateHttpUrl(siteUrl, options.privateOrigins ?? getConfig().allowedPrivateOrigins)).href;
  try {
    const response = await safeFetch(siteUrl, { ...options, purpose: 'discovery', maxBytes: 1024 * 1024, maxCompressedBytes: 512 * 1024, deadlineMs: 15_000 });
    if (response.status !== 200 || !/^(text\/html|application\/xhtml\+xml)/i.test(response.headers['content-type'] ?? '')) return [fallback];
    return [...pageLinks(response.bytes.toString('utf8'), response.url, options.privateOrigins ?? getConfig().allowedPrivateOrigins).icons, new URL('/favicon.ico', response.url).href].slice(0, 9);
  } catch { return [fallback]; }
}

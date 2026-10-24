import { lookup } from 'node:dns/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { getConfig } from '../config';
import { withWorkerHostSlot } from './host-limits';

export class FetchError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number, public readonly retryAfter?: number) {
    super(message); this.name = 'FetchError';
  }
}
export interface SafeFetchOptions {
  purpose?: 'feed' | 'discovery' | 'image';
  credentials?: { username: string; password: string };
  etag?: string | null; lastModified?: string | null;
  signal?: AbortSignal;
  /** Operator configuration only. Never populate this from browser input. */
  privateOrigins?: readonly string[];
  /** Internal worker policy; never populate from a browser request body. */
  coordinateWorkerHost?: boolean;
  maxBytes?: number; maxCompressedBytes?: number; deadlineMs?: number; maxRedirects?: number;
}
export interface SafeFetchResponse {
  url: string; status: number; headers: IncomingHttpHeaders; bytes: Buffer;
  redirects: string[]; conditional?: boolean;
}
interface HostGate { active:number; nextStart:number; waiters:Array<{resolve:()=>void;reject:(error:Error)=>void;signal:AbortSignal;abort:()=>void}>; }
const hostGates = new Map<string, HostGate>();
const USER_AGENT = 'Fever/Next (+self-hosted feed reader)';
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new FetchError('cancelled', 'Request cancelled.')); return; }
  const done = () => { signal.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(new FetchError('cancelled', 'Request cancelled.')); };
  signal.addEventListener('abort', abort, { once: true });
});

export function validateHttpUrl(input: string, privateOrigins: readonly string[] = []): URL {
  if (typeof input !== 'string' || !input.trim() || input.length > 16_384 || /[\u0000-\u0020\u007f\\]/.test(input)) {
    throw new FetchError('invalid_url', 'Enter a valid HTTP or HTTPS URL.');
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new FetchError('invalid_url', 'Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.hostname.endsWith('.')) {
    throw new FetchError('invalid_url', 'This URL scheme, host, or embedded credential is not allowed.');
  }
  const rawHost = input.match(/^https?:\/\/([^/?#]+)/i)?.[1].replace(/:\d+$/, '');
  if (!rawHost) throw new FetchError('invalid_url', 'This URL is not supported.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // WHATWG URL normalizes octal, hex, and shortened IPv4. Reject those spellings.
  if (isIP(hostname) === 4 && rawHost.toLowerCase() !== hostname) throw new FetchError('blocked_address', 'Alternate IP encodings are not allowed.');
  if (url.port && !privateOrigins.includes(url.origin)) throw new FetchError('blocked_port', 'Only standard HTTP and HTTPS ports are allowed.');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(hostname) && !privateOrigins.includes(url.origin)) {
    throw new FetchError('blocked_address', 'Private network addresses are not allowed.');
  }
  url.hash = '';
  return url;
}
function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    return parsed.range() === 'unicast' && !(parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress());
  } catch { return false; }
}
async function resolvedAddress(url: URL, privateOrigins: readonly string[], signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new FetchError('timeout', 'The request deadline was exceeded.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const records = isIP(hostname) ? [{ address: hostname }] : await new Promise<Array<{ address: string }>>((resolve, reject) => {
    const abort = () => reject(new FetchError('timeout', 'DNS lookup exceeded the request deadline.'));
    signal.addEventListener('abort', abort, { once: true });
    lookup(hostname, { all: true, verbatim: true }).then(resolve, () => reject(new FetchError('dns', 'The feed host could not be resolved.'))).finally(() => signal.removeEventListener('abort', abort));
  });
  if (!records.length || (!privateOrigins.includes(url.origin) && records.some(record => !publicAddress(record.address)))) {
    throw new FetchError('blocked_address', 'The destination resolves to a private or reserved network address.');
  }
  return (records.find(record => isIP(record.address) === 4) ?? records[0]).address;
}
async function hostSlot<T>(host: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  const gate: HostGate = hostGates.get(host) ?? { active:0,nextStart:0,waiters:[] };
  hostGates.set(host,gate);
  const capacity = getConfig().perHostConcurrency;
  if (gate.active < capacity) gate.active++;
  else await new Promise<void>((resolve,reject) => {
    const waiter = { resolve,reject,signal,abort:()=>{} };
    waiter.abort = () => { const index=gate.waiters.indexOf(waiter); if(index>=0) gate.waiters.splice(index,1); reject(new FetchError('timeout','The request deadline was exceeded.')); };
    if(signal.aborted) { waiter.abort(); return; }
    gate.waiters.push(waiter); signal.addEventListener('abort',waiter.abort,{once:true});
  });
  try {
    if(signal.aborted) throw new FetchError('timeout','The request deadline was exceeded.');
    const start = Math.max(Date.now(),gate.nextStart); gate.nextStart=start+500;
    if(start>Date.now()) await delay(start-Date.now(),signal);
    return await operation();
  } finally {
    gate.active--;
    while(gate.waiters.length) {
      const waiter=gate.waiters.shift()!; waiter.signal.removeEventListener('abort',waiter.abort);
      if(waiter.signal.aborted) { waiter.reject(new FetchError('timeout','The request deadline was exceeded.')); continue; }
      gate.active++; waiter.resolve(); break;
    }
    if(gate.active===0 && gate.waiters.length===0) {
      const cleanup=setTimeout(()=>{if(gate.active===0 && gate.waiters.length===0 && hostGates.get(host)===gate) hostGates.delete(host);},1000);
      cleanup.unref();
    }
  }
}
function limitStream(limit: number) {
  let count = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    count += chunk.length;
    callback(count > limit ? new FetchError('too_large', 'The response exceeds the allowed size.') : null, chunk);
  } });
}
function requestOnce(url: URL, address: string, headers: Record<string, string>, options: SafeFetchOptions, signal: AbortSignal): Promise<Omit<SafeFetchResponse, 'redirects'>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new FetchError('timeout', 'The request deadline was exceeded.')); return; }
    const secure = url.protocol === 'https:';
    const req = (secure ? https : http).request({
      protocol: url.protocol, hostname: address, port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search, method: 'GET', agent: false, signal, maxHeaderSize: 16 * 1024,
      headers: { ...headers, Host: url.host },
      ...(secure ? { servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname, rejectUnauthorized: true } : {}),
    }, async response => {
      clearTimeout(connectTimer);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308, 304].includes(status)) {
        response.destroy(); resolve({ url: url.href, status, headers: response.headers, bytes: Buffer.alloc(0) }); return;
      }
      const maxBytes = Math.min(options.maxBytes ?? 8 * 1024 * 1024, 20 * 1024 * 1024);
      const maxCompressed = Math.min(options.maxCompressedBytes ?? 4 * 1024 * 1024, 10 * 1024 * 1024);
      if (Number(response.headers['content-length'] ?? 0) > maxCompressed) { response.destroy(); reject(new FetchError('too_large', 'The response exceeds the allowed size.')); return; }
      const encoding = (response.headers['content-encoding'] ?? 'identity').toLowerCase();
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
      if (!decoder && encoding !== 'identity') { response.destroy(); reject(new FetchError('encoding', 'Unsupported response compression.')); return; }
      const chunks: Buffer[] = [];
      const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
      try {
        if (decoder) await pipeline(response, limitStream(maxCompressed), decoder, limitStream(maxBytes), sink, { signal });
        else await pipeline(response, limitStream(Math.min(maxCompressed, maxBytes)), sink, { signal });
        resolve({ url: url.href, status, headers: response.headers, bytes: Buffer.concat(chunks) });
      } catch (error) { reject(error); }
    });
    const connectTimer = setTimeout(() => req.destroy(new FetchError('timeout', 'Connection timed out.')), 8_000);
    req.setTimeout(10_000, () => req.destroy(new FetchError('timeout', 'The remote server stopped responding.')));
    req.once('socket', socket => socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer)));
    req.once('error', error => { clearTimeout(connectTimer); reject(error); });
    req.end();
  });
}
export function retryAfterSeconds(value: string | string[] | undefined, now = Date.now()): number | undefined {
  if (typeof value !== 'string') return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.min(86_400, Math.max(0, Math.ceil(seconds))) : undefined;
}
export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const config = getConfig();
  for (const value of [options.maxBytes, options.maxCompressedBytes, options.deadlineMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new FetchError('limits', 'Request limits must be positive integers.');
  }
  const maxRedirects = options.maxRedirects ?? config.maxRedirects;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 4) throw new FetchError('limits', 'The redirect limit must be between zero and four.');
  const configuredBytes = options.purpose === 'image' ? config.maxMediaBytes : config.maxFeedBytes;
  options = { ...options, maxBytes: Math.min(options.maxBytes ?? configuredBytes,configuredBytes), deadlineMs: Math.min(options.deadlineMs ?? config.fetchTimeoutMs,config.fetchTimeoutMs) };
  const privateOrigins = options.privateOrigins ?? config.allowedPrivateOrigins;
  let url = validateHttpUrl(input, privateOrigins);
  const redirects: string[] = [];
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: options.purpose === 'image' ? 'image/png,image/jpeg,image/webp,image/gif,image/x-icon;q=0.8' : 'application/atom+xml,application/rss+xml,application/xml,text/xml,text/html;q=0.8,*/*;q=0.1', 'Accept-Encoding': 'gzip, deflate, br' };
  if (options.etag) headers['If-None-Match'] = options.etag;
  if (options.lastModified) headers['If-Modified-Since'] = options.lastModified;
  if (options.credentials) {
    if (options.credentials.username.includes(':') || /[\r\n]/.test(options.credentials.username + options.credentials.password)) throw new FetchError('credentials', 'Feed credentials contain unsupported characters.');
    headers.Authorization = `Basic ${Buffer.from(`${options.credentials.username}:${options.credentials.password}`).toString('base64')}`;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, Math.min(options.deadlineMs ?? 30_000, 60_000));
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const response = await hostSlot(url.hostname, controller.signal, async () => {
        const address = await resolvedAddress(url, privateOrigins, controller.signal);
        const operation = () => requestOnce(url, address, headers, options, controller.signal);
        return options.coordinateWorkerHost
          ? withWorkerHostSlot(url.hostname, controller.signal, abort, operation)
          : operation();
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return { ...response, redirects, conditional: Boolean(headers['If-None-Match'] || headers['If-Modified-Since']) };
      if (hop === maxRedirects || !response.headers.location) throw new FetchError('redirect', 'The response has too many redirects or an invalid redirect.');
      const next = validateHttpUrl(new URL(response.headers.location, url).href, privateOrigins);
      if (url.protocol === 'https:' && next.protocol === 'http:') throw new FetchError('redirect', 'An insecure HTTPS-to-HTTP redirect was refused.');
      if (next.origin !== url.origin) { delete headers.Authorization; delete headers['If-None-Match']; delete headers['If-Modified-Since']; }
      redirects.push(next.href); url = next;
    }
    throw new FetchError('redirect', 'The redirect limit was exceeded.');
  } catch (error) {
    if (controller.signal.aborted) throw new FetchError(options.signal?.aborted ? 'cancelled' : 'timeout', options.signal?.aborted ? 'Request cancelled.' : 'The request deadline was exceeded.');
    if (error instanceof FetchError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? '';
    throw new FetchError(/CERT|TLS|SSL/.test(code) ? 'tls' : 'network', /CERT|TLS|SSL/.test(code) ? 'The remote TLS certificate could not be verified.' : 'The remote server could not be reached.');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

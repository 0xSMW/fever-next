import { getConfig } from '../config';
import { decryptSecret, encryptionKeyId } from '../crypto';
import type { FeedLease } from '../jobs/types';
import { FetchError, retryAfterSeconds, safeFetch, type SafeFetchOptions } from './http';
import { parseFeed } from './parser';
import { discoverIconUrls } from './discovery';
import { fetchSafeImage } from './images';
import { commitRefresh, commitFailure, type RefreshOutcome } from './persist';

function storedCredentials(lease: FeedLease): SafeFetchOptions['credentials'] {
  if (!lease.credentialCiphertext) return undefined;
  try {
    if (encryptionKeyId(lease.credentialCiphertext) !== lease.credentialKeyId) throw new Error('key mismatch');
    const value: unknown = JSON.parse(decryptSecret(lease.credentialCiphertext, `feed:${lease.feed.id}`));
    if (!value || typeof value !== 'object' || !('username' in value) || !('password' in value) || typeof value.username !== 'string' || typeof value.password !== 'string') throw new Error('format');
    return { username: value.username, password: value.password };
  } catch { throw new FetchError('credentials_unavailable', 'The stored feed credentials could not be decrypted. Check the configured encryption key.'); }
}
/** Fetch and parse outside all SQL transactions. The caller owns heartbeat/cancellation. */
export async function prepareRefresh(lease: FeedLease, signal?: AbortSignal): Promise<RefreshOutcome> {
  const config = getConfig();
  const credentials = storedCredentials(lease);
  const options: SafeFetchOptions = { signal, credentials, privateOrigins: config.allowedPrivateOrigins, deadlineMs: config.fetchTimeoutMs, maxBytes: config.maxFeedBytes, coordinateWorkerHost: true };
  const outcome: RefreshOutcome = { warnings: [] };
  if (!lease.job.faviconOnly) {
    const response = await safeFetch(lease.feed.url, { ...options, etag: lease.job.force ? undefined : lease.etag, lastModified: lease.job.force ? undefined : lease.lastModified });
    outcome.response = response;
    if (response.status === 304) {
      if (!response.conditional) throw new FetchError('invalid_304', 'The server returned not-modified without a conditional request.');
    } else if (response.status !== 200) {
      const code = response.status === 401 ? 'requires_auth' : response.status === 404 ? 'not_found' : response.status === 410 ? 'gone' : response.status === 429 ? 'rate_limited' : 'http';
      throw new FetchError(code, `The feed server returned HTTP ${response.status}.`, response.status, retryAfterSeconds(response.headers['retry-after']));
    } else {
      const type = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!['', 'application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/xml', 'text/xml', 'text/plain', 'application/octet-stream'].includes(type)) throw new FetchError('content_type', 'The feed server did not return a supported XML content type.');
      outcome.parsed = parseFeed(response.bytes, response.url, Math.floor(Date.now() / 1000), response.headers['content-type'], config.maxFeedItems);
    }
  }
  if (!lease.feed.faviconId || lease.feed.faviconId === 1 || lease.job.faviconOnly) {
    const site = outcome.parsed?.siteUrl || lease.feed.siteUrl || lease.feed.url;
    const credentialsFor = (url: string) => {
      try { return new URL(url).origin === new URL(lease.feed.url).origin ? credentials : undefined; }
      catch { return undefined; }
    };
    let icons: string[] = [];
    try { icons = await discoverIconUrls(site, { ...options, credentials: credentialsFor(site) }); }
    catch (error) { if (error instanceof FetchError && error.code === 'cancelled') throw error; }
    for (const icon of icons) {
      if (signal?.aborted) throw new FetchError('cancelled', 'Refresh cancelled.');
      try { outcome.image = await fetchSafeImage(icon, { ...options, credentials: credentialsFor(icon), favicon: true, deadlineMs: 12_000 }); break; }
      catch (error) { if (error instanceof FetchError && error.code === 'cancelled') throw error; }
    }
    if (!outcome.image) outcome.warnings.push('A safe favicon could not be downloaded; the existing or default icon remains in use.');
  }
  return outcome;
}
export { commitRefresh, commitFailure };

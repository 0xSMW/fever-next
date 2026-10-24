import type { PoolClient } from 'pg';
import { getConfig } from '../config';
import { sha256 } from '../crypto';
import { MAX_CRC32, safeInteger, toId } from '../db/numbers';
import { canonicalUrlKey, checksum, normalizeUrl, trueUrl } from '../legacy-url';
import { acquireBlacklistReadLock, compileBlacklist } from '../domain/blacklist';
import { transaction } from '../jobs/transactions';
import { assertLease, updateJobProgress } from '../jobs/worker';
import type { FeedLease } from '../jobs/types';
import { extractLinkOccurrences, weightFeedLinks } from './links';
import { rankingContent } from './ranking-content';
import type { ParsedFeed, ParsedItem } from './parser';
import type { SafeImage } from './images';
import type { SafeFetchResponse } from './http';

type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
export interface RefreshOutcome { response?: SafeFetchResponse; parsed?: ParsedFeed; image?: SafeImage; warnings: string[]; }
interface LinkWeightUpdate { id: number; weight: number; isFirst: boolean; }
/** Called inside the fenced refresh transaction, after weighting the retained feed. */
export async function persistLinkWeights(client: Pick<PoolClient, 'query'>, feedId: number, links: readonly LinkWeightUpdate[]): Promise<void> {
  const id = toId(feedId);
  const checked = links.map(link => {
    if (typeof link.isFirst !== 'boolean') throw new TypeError('Link first-occurrence state must be a boolean.');
    return { id: toId(link.id), weight: safeInteger(link.weight, 'link weight', 0, MAX_CRC32), isFirst: link.isFirst };
  });
  for (let offset = 0; offset < checked.length; offset += 1000) {
    const batch = checked.slice(offset, offset + 1000);
    await client.query(`UPDATE link_occurrences AS l SET weight=b.weight,is_first=b.is_first
      FROM unnest($1::bigint[],$2::bigint[],$3::boolean[]) AS b(id,weight,is_first)
      WHERE l.feed_id=$4 AND l.id=b.id AND (l.weight<>b.weight OR l.is_first<>b.is_first)`,
    [batch.map(link => link.id), batch.map(link => link.weight), batch.map(link => link.isFirst), id]);
  }
}
async function snapshot(client: PoolClient, feedId: number): Promise<Snapshot> {
  const result: Snapshot = {};
  // Lock article state before capturing it; a simultaneous reader save/read must
  // not be misattributed to this worker's replay journal.
  await client.query('SELECT id FROM items WHERE feed_id=$1 ORDER BY id FOR UPDATE', [feedId]);
  // No network awaits occur within this transaction. Identifiers are fixed literals.
  for (const table of ['feeds', 'feed_fetch_state', 'items', 'item_identity_aliases', 'link_occurrences'] as const) {
    const column = table === 'feeds' ? 'id' : 'feed_id';
    result[table] = (await client.query(`SELECT * FROM ${table} WHERE ${column}=$1 ORDER BY ${table === 'item_identity_aliases' ? 'alias_key' : table === 'feed_fetch_state' ? 'feed_id' : 'id'}`, [feedId])).rows;
  }
  return result;
}
function differences(before: Snapshot, after: Snapshot): { before: Snapshot; after: Snapshot } {
  const old: Snapshot = {}; const next: Snapshot = {};
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const key = (row: Row) => String(row.id ?? row.alias_key ?? row.feed_id);
    const a = new Map((before[table] ?? []).map(row => [key(row), row]));
    const b = new Map((after[table] ?? []).map(row => [key(row), row]));
    old[table] = []; next[table] = [];
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      if (JSON.stringify(a.get(id)) === JSON.stringify(b.get(id))) continue;
      if (a.has(id)) old[table].push(a.get(id)!);
      if (b.has(id)) next[table].push(b.get(id)!);
    }
  }
  return { before: old, after: next };
}
async function journal(client: PoolClient, lease: FeedLease, action: string, before: Snapshot, after: Snapshot, warnings: string[] = []): Promise<void> {
  const delta = differences(before, after);
  await client.query('INSERT INTO state_operations(owner_id,idempotency_key,origin,action,affected_ids,before,after) VALUES($1,$2,\'worker\',$3,$4::jsonb,$5::jsonb,$6::jsonb)', [
    lease.job.ownerId, `worker:${lease.job.id}:${lease.resultId}:${lease.fence}:${action}`, action, JSON.stringify([lease.feed.id]),
    JSON.stringify({ version: 1, scope: { feedId: lease.feed.id }, tables: delta.before }),
    JSON.stringify({ version: 1, scope: { feedId: lease.feed.id }, tables: delta.after, warnings }),
  ]);
}
interface Alias { alias: string; kind: string; key: string; }
function aliases(item: ParsedItem): Alias[] {
  const result = item.rawUid ? [{ kind: 'uid', alias: item.rawUid }] : item.url ? [{ kind: 'url', alias: item.url }] : [{ kind: 'fingerprint', alias: item.sourceFingerprint }];
  if (item.legacyUid) result.push({ kind: 'legacy_uid', alias: item.legacyUid });
  return result.map(alias => ({ ...alias, key: sha256(`${alias.kind}:${alias.alias}`) }));
}
async function quarantine(client: PoolClient, lease: FeedLease, item: ParsedItem, code: string): Promise<void> {
  await client.query(`INSERT INTO ingest_quarantine(feed_id,job_id,identity_key,code,source_fingerprint,payload)
    VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(feed_id,source_fingerprint,code) DO UPDATE SET last_seen_at=clock_timestamp(),occurrences=ingest_quarantine.occurrences+1,job_id=EXCLUDED.job_id`, [lease.feed.id, lease.job.id, item.identityKey, code, item.sourceFingerprint, JSON.stringify(item)]);
}
async function existingItem(client: PoolClient, lease: FeedLease, item: ParsedItem, names: Alias[]): Promise<Row | 'conflict' | undefined> {
  const direct = await client.query('SELECT * FROM items WHERE feed_id=$1 AND identity_key=$2 FOR UPDATE', [lease.feed.id, item.identityKey]);
  if (direct.rowCount) {
    const row = direct.rows[0];
    if (item.rawUid && row.raw_uid !== item.rawUid) return 'conflict';
    if (!item.rawUid && item.url && row.url !== item.url) return 'conflict';
    if (!item.rawUid && !item.url && (row.raw_html !== item.rawHtml || row.title !== item.title || row.author !== item.author)) return 'conflict';
    return row;
  }
  const found = await client.query('SELECT a.alias,a.alias_key,a.kind,i.* FROM item_identity_aliases a JOIN items i ON i.id=a.item_id AND i.feed_id=a.feed_id WHERE a.feed_id=$1 AND a.alias_key=ANY($2::varchar[]) FOR UPDATE OF i', [lease.feed.id, names.map(alias => alias.key)]);
  const ids = new Set(found.rows.map(row => String(row.id)));
  if (ids.size > 1) return 'conflict';
  for (const row of found.rows) {
    const alias = names.find(value => value.key === row.alias_key);
    if (!alias || alias.alias !== row.alias || alias.kind !== row.kind) return 'conflict';
    // A legacy truncated UID can recognize an imported item, but cannot merge
    // two already-observed full GUIDs that happen to share the first 255 bytes.
    if (item.rawUid && row.raw_uid && row.raw_uid !== item.rawUid && row.raw_uid !== item.legacyUid) return 'conflict';
    if (!item.rawUid && row.raw_uid && row.raw_uid !== item.legacyUid) return 'conflict';
  }
  return found.rows[0];
}
async function saveImage(client: PoolClient, lease: FeedLease, image: SafeImage, now: number): Promise<number> {
  const canonicalUrl = normalizeUrl(image.url);
  const key = canonicalUrlKey(canonicalUrl);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fever:favicon-content:${lease.job.ownerId}:${image.hash}`]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fever:favicon-url:${lease.job.ownerId}:${key}`]);
  const existing = await client.query('SELECT id,owner_id,url,url_key,url_checksum,mime_type,encode(data,\'base64\') AS data_base64,content_hash,cached_at,is_default FROM favicons WHERE owner_id=$1 AND url_key=$2 FOR UPDATE', [lease.job.ownerId, key]);
  if (existing.rowCount && normalizeUrl(existing.rows[0].url) !== canonicalUrl) throw new Error('Favicon URL identity collision.');
  // Preserve stable IDs for a URL; equal content under another URL may share an ID.
  if (!existing.rowCount) {
    const identical = await client.query('SELECT id,data FROM favicons WHERE owner_id=$1 AND content_hash=$2 AND NOT is_default ORDER BY id LIMIT 1', [lease.job.ownerId, image.hash]);
    if (identical.rowCount && Buffer.from(identical.rows[0].data).equals(image.bytes)) return toId(identical.rows[0].id);
  }
  const saved = await client.query(`INSERT INTO favicons(owner_id,url,url_key,url_checksum,mime_type,data,content_hash,cached_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(owner_id,url_key) DO UPDATE SET mime_type=EXCLUDED.mime_type,data=EXCLUDED.data,content_hash=EXCLUDED.content_hash,cached_at=EXCLUDED.cached_at
    RETURNING id,owner_id,url,url_key,url_checksum,mime_type,encode(data,'base64') AS data_base64,content_hash,cached_at,is_default`, [lease.job.ownerId, image.url, key, checksum(image.url), image.mime, image.bytes, image.hash, now]);
  await journal(client, lease, 'ingest.favicon', { favicons: existing.rows }, { favicons: saved.rows });
  return toId(saved.rows[0].id);
}
export async function commitRefresh(lease: FeedLease, outcome: RefreshOutcome): Promise<void> {
  const config = getConfig();
  const requestIsHttps = config.baseUrl?.startsWith('https:');
  await transaction(async client => {
    await assertLease(client, lease.job, lease);
    await acquireBlacklistReadLock(client, lease.job.ownerId);
    const prefs = await client.query('SELECT blacklist,item_expiration,refresh_interval FROM reader_preferences WHERE owner_id=$1', [lease.job.ownerId]);
    const blacklist = compileBlacklist(prefs.rows[0].blacklist);
    const before = await snapshot(client, lease.feed.id);
    const now = Math.floor(Date.now() / 1000);
    const expires = now - safeInteger(prefs.rows[0].item_expiration) * 7 * 86_400;
    const warnings = [...outcome.warnings, ...(outcome.parsed?.warnings ?? []), ...blacklist.issues.map(issue => `Blacklist rule ${issue.position + 1} could not be applied: ${issue.message}`)];
    let added = 0; let updated = 0; let newest = 0; let latestAdded = 0;
    let linksChanged = false;
    const siteUrl = outcome.parsed?.siteUrl || lease.feed.siteUrl || lease.feed.url;
    const domain = normalizeUrl(siteUrl).replace(/\/.*$/, '');
    const extractionFeed = { id: lease.feed.id, siteUrl, domain };
    for (const rejected of outcome.parsed?.quarantined ?? []) await quarantine(client, lease, rejected.item, rejected.code);
    for (const item of outcome.parsed?.items ?? []) {
      // Freeze skips as well as deletion while migration/rehearsal retains evidence.
      if (config.retentionEnabled && item.publishedAt > 0 && item.publishedAt < expires) continue;
      const names = aliases(item);
      const existing = await existingItem(client, lease, item, names);
      if (existing === 'conflict') { await quarantine(client, lease, item, 'identity_collision'); warnings.push('An ambiguous item identity was quarantined without changing the stored article.'); continue; }
      const canonical = item.url ? normalizeUrl(trueUrl(item.url)) : '';
      if (existing && item.rawUid && existing.url !== item.url) warnings.push('A publisher changed the URL for an existing stable entry ID; its reading state and original publication time were preserved.');
      let itemId: number; let publishedAt: number;
      if (existing) {
        itemId = toId(existing.id); publishedAt = safeInteger(existing.published_at);
        if (existing.content_hash !== item.contentHash || existing.identity_key !== item.identityKey || existing.sanitizer_version !== item.sanitizerVersion) {
          await client.query(`UPDATE items SET raw_uid=$2,legacy_uid=$3,identity_key=$4,title=$5,author=$6,raw_html=$7,html=$8,search_text=$9,sanitizer_version=$10,url=$11,canonical_url=$12,url_key=$13,url_checksum=$14,updated_at=$15,content_hash=$16,source_fingerprint=$17 WHERE id=$1`, [itemId, item.rawUid, item.legacyUid || null, item.identityKey, item.title, item.author, item.rawHtml, item.sanitizedHtml, item.searchText, item.sanitizerVersion, item.url, canonical, item.url ? canonicalUrlKey(canonical) : null, checksum(canonical), now, item.contentHash, item.sourceFingerprint]);
          updated++; linksChanged = true;
        } else continue;
      } else {
        publishedAt = item.publishedAt || now;
        const created = await client.query(`INSERT INTO items(feed_id,raw_uid,legacy_uid,identity_key,title,author,raw_html,html,search_text,sanitizer_version,url,canonical_url,url_key,url_checksum,published_at,added_at,updated_at,content_hash,source_fingerprint)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18) RETURNING id`, [lease.feed.id, item.rawUid, item.legacyUid || null, item.identityKey, item.title, item.author, item.rawHtml, item.sanitizedHtml, item.searchText, item.sanitizerVersion, item.url, canonical, item.url ? canonicalUrlKey(canonical) : null, checksum(canonical), publishedAt, now, item.contentHash, item.sourceFingerprint]);
        itemId = toId(created.rows[0].id); added++; linksChanged = true;
        newest = Math.max(newest, publishedAt); latestAdded = now;
      }
      for (const alias of names) {
        const saved = await client.query(`INSERT INTO item_identity_aliases(feed_id,alias_key,alias,kind,item_id) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(feed_id,alias_key) DO UPDATE SET alias=EXCLUDED.alias WHERE item_identity_aliases.item_id=EXCLUDED.item_id AND item_identity_aliases.alias=EXCLUDED.alias AND item_identity_aliases.kind=EXCLUDED.kind RETURNING item_id`, [lease.feed.id, alias.key, alias.alias, alias.kind, itemId]);
        if (!saved.rowCount) throw new Error('Item alias identity collision.');
      }
      await client.query('DELETE FROM link_occurrences WHERE item_id=$1', [itemId]);
      const occurrences = extractLinkOccurrences({ id: itemId, feedId: lease.feed.id, title: item.title, url: item.url, html: rankingContent(item.rawHtml, siteUrl, requestIsHttps), publishedAt }, extractionFeed, blacklist, { requestIsHttps });
      for (const link of occurrences) {
        await client.query(`INSERT INTO link_occurrences(feed_id,item_id,original_url,url,canonical_url,url_key,url_checksum,title_url_checksum,title,is_item,is_local,is_blacklisted,is_first,weight,created_at,normalization_version,ranking_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [link.feedId, link.itemId, link.originalUrl, link.url, link.canonicalUrl, link.urlKey, link.urlChecksum, link.titleUrlChecksum, link.title, link.isItem, link.isLocal, link.isBlacklisted, link.isFirst, link.weight, link.createdAt, link.normalizationVersion, link.rankingVersion]);
      }
    }
    if (config.retentionEnabled && !lease.job.faviconOnly) {
      const expiredLinks = await client.query('DELETE FROM link_occurrences WHERE feed_id=$1 AND created_at<$2', [lease.feed.id, expires]);
      const expiredItems = await client.query('DELETE FROM items WHERE feed_id=$1 AND published_at<$2 AND NOT is_saved', [lease.feed.id, expires]);
      linksChanged ||= Boolean(expiredLinks.rowCount || expiredItems.rowCount);
    }
    if (linksChanged || lease.job.force) {
      const links = await client.query('SELECT * FROM link_occurrences WHERE feed_id=$1 ORDER BY created_at,id', [lease.feed.id]);
      const weighted = weightFeedLinks(links.rows.map(row => ({ id: toId(row.id), feedId: toId(row.feed_id), canonicalUrl: row.canonical_url as string, urlKey: row.url_key as string, urlChecksum: safeInteger(row.url_checksum), url: row.url as string, isItem: row.is_item as boolean, isLocal: row.is_local as boolean, createdAt: safeInteger(row.created_at), weight: safeInteger(row.weight), isFirst: row.is_first as boolean })));
      await persistLinkWeights(client, lease.feed.id, weighted);
    }
    const faviconId = outcome.image ? await saveImage(client, lease, outcome.image, now) : lease.feed.faviconId;
    await client.query(`UPDATE feeds SET title=CASE WHEN $2<>'' THEN $2 ELSE title END,site_url=$3,domain=$4,favicon_id=CASE WHEN $7 THEN $5 ELSE favicon_id END,requires_auth=CASE WHEN $6 THEN false ELSE requires_auth END,updated_at=clock_timestamp() WHERE id=$1`, [lease.feed.id, outcome.parsed?.title ?? '', siteUrl, domain, faviconId, !lease.job.faviconOnly, Boolean(outcome.image)]);
    if (!lease.job.faviconOnly) await client.query('UPDATE feed_credentials SET last_auth_error=NULL WHERE feed_id=$1', [lease.feed.id]);
    const nextAttempt = now + safeInteger(prefs.rows[0].refresh_interval) * 60 + Math.floor(Math.random() * 30);
    await client.query(`UPDATE feed_fetch_state SET last_success_at=CASE WHEN $2 THEN last_success_at ELSE $3 END,last_updated_at=GREATEST(last_updated_at,$4),last_added_at=GREATEST(last_added_at,$5),next_attempt_at=CASE WHEN $2 THEN next_attempt_at ELSE $6 END,
      status=CASE WHEN $2 THEN status ELSE 'ok' END,last_status_code=COALESCE($7,last_status_code),last_error=$8,
      etag=CASE WHEN $2 THEN etag WHEN $9=304 THEN COALESCE($10,etag) ELSE $10 END,last_modified=CASE WHEN $2 THEN last_modified WHEN $9=304 THEN COALESCE($11,last_modified) ELSE $11 END,
      final_url=COALESCE($12,final_url),redirect_history=CASE WHEN $13::jsonb IS NULL THEN redirect_history ELSE $13::jsonb END,failure_count=CASE WHEN $2 THEN failure_count ELSE 0 END,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE feed_id=$1`, [lease.feed.id, lease.job.faviconOnly, now, newest, latestAdded, nextAttempt, outcome.response?.status ?? null, warnings.length ? warnings.join(' ').slice(0, 2000) : null, outcome.response?.status ?? null, outcome.response?.headers.etag ?? null, outcome.response?.headers['last-modified'] ?? null, outcome.response?.url ?? null, outcome.response ? JSON.stringify(outcome.response.redirects) : null]);
    await client.query("UPDATE job_feed_results SET status='completed',added_items=$2,updated_items=$3,status_code=$4,error=$5,finished_at=clock_timestamp() WHERE id=$1 AND fence=$6", [lease.resultId, added, updated, outcome.response?.status ?? null, warnings.length ? warnings.join(' ').slice(0, 2000) : null, lease.fence]);
    await updateJobProgress(client, lease.job);
    await journal(client, lease, 'ingest.feed', before, await snapshot(client, lease.feed.id), warnings);
  });
}
export async function commitFailure(lease: FeedLease, error: { code: string; message: string; status?: number; retryAfter?: number }): Promise<void> {
  await transaction(async client => {
    await assertLease(client, lease.job, lease);
    const before = await snapshot(client, lease.feed.id);
    const transient = ['timeout', 'dns', 'network'].includes(error.code) || error.status === 429 || (error.status !== undefined && error.status >= 500);
    const retry = transient && lease.attempts < 3;
    const failures = Math.min(lease.failureCount + 1, 30);
    const wait = Math.min(86_400, Math.max(error.retryAfter ?? 0, retry ? 15 * 2 ** (lease.attempts - 1) : lease.intervalMinutes * 60 * 2 ** Math.min(failures, 6))) + Math.floor(Math.random() * 15);
    const message = error.message.slice(0, 1000);
    await client.query(`UPDATE feed_fetch_state SET status=$2,last_status_code=$3,last_error=$4,failure_count=$5,next_attempt_at=floor(extract(epoch FROM clock_timestamp()))+$6,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE feed_id=$1`, [lease.feed.id, error.code, error.status ?? null, message, failures, wait]);
    if (error.status === 401) {
      await client.query('UPDATE feeds SET requires_auth=true WHERE id=$1', [lease.feed.id]);
      await client.query("UPDATE feed_credentials SET last_auth_error='The server rejected the stored credentials.' WHERE feed_id=$1", [lease.feed.id]);
    }
    await client.query('UPDATE job_feed_results SET status=$2,status_code=$3,error=$4,finished_at=CASE WHEN $2=\'retry\' THEN NULL ELSE clock_timestamp() END WHERE id=$1 AND fence=$5', [lease.resultId, retry ? 'retry' : 'failed', error.status ?? null, message, lease.fence]);
    await updateJobProgress(client, lease.job);
    await journal(client, lease, 'ingest.failure', before, await snapshot(client, lease.feed.id));
  });
}

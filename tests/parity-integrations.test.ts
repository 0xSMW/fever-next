import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { resolve } from 'node:path';
import test from 'node:test';
import { phpExecutable, sourceRoot, verifyOracleSource } from './hot-oracle';
import type { Client } from 'pg';
import { SaxesParser } from 'saxes';
import { initializeInstallation } from '../lib/auth/setup';
import { closeDatabase, getPool } from '../lib/db/client';
import { assertTarget, closeTarget } from '../lib/migration/target';
import { canonicalUrlKey, normalizeUrl } from '../lib/legacy-url';
import { handleFever } from '../lib/compat/fever';
import { feverXml, type FeverValue } from '../lib/compat/serialize';
import { rootCompatibility } from '../lib/compat/root';
import { getNavigation, getReaderView } from '../lib/domain/reader';
import { mutateItems } from '../lib/domain/state';
import { createFeed, createGroup, updateFeed } from '../lib/domain/subscriptions';
import { savePreferences } from '../lib/domain/preferences';
import { mediaResponse, faviconResponse } from '../lib/integrations/media';
import { exportOpml, importOpml, parseOpml } from '../lib/integrations/opml';
import { expandSharingTemplate, shareItem } from '../lib/integrations/sharing';
import { savedRss } from '../lib/integrations/rss';

const enabled = process.env.FEVER_PARITY_TESTS === '1';
const endpoint = 'ep-blue-field-arn6ictb.c-4.us-west-2.aws.neon.tech';
const fingerprint = 'f68fe9974e8638485c07d78598dd895996ac3e651f0eb0edea9824f738a8db54';
const evidenceDirectory = resolve(process.env.FEVER_TEST_EVIDENCE_DIR ?? 'tests/.artifacts/parity');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
const blockedDestination = (error: unknown) => hasCode('blocked_address')(error) || hasCode('blocked_port')(error);

interface XmlNode { name: string; text: string; attributes: Record<string, string>; children: XmlNode[]; }
function parseXml(xml: string): XmlNode {
  const roots: XmlNode[] = [], stack: XmlNode[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', tag => {
    const node = { name: tag.name, text: '', attributes: tag.attributes as Record<string, string>, children: [] };
    if (stack.length) stack.at(-1)!.children.push(node); else roots.push(node);
    stack.push(node);
  });
  parser.on('text', text => { if (stack.length) stack.at(-1)!.text += text; });
  parser.on('cdata', text => { if (stack.length) stack.at(-1)!.text += text; });
  parser.on('closetag', () => { stack.pop(); });
  parser.on('error', error => { throw error; });
  parser.write(xml).close();
  assert.equal(roots.length, 1);
  return roots[0];
}

// Executes the owning PHP route_api method and serializers unchanged. Only the
// database/bootstrap boundary is shimmed: fixture tables live in PDO SQLite.
// This establishes route/query semantics, not MySQL-driver or live-client parity.
const phpOracle = String.raw`
function low($v) { return strtolower($v); }
function r($p,$r,$v) { return preg_replace($p,$r,$v); }
function h($v) { return htmlspecialchars((string)$v, ENT_QUOTES); }
function sr($a,$b,$v) { return str_replace($a,$b,$v); }
$input=json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$source=file_get_contents($input['source']);
$start=strpos($source, "\tfunction route_api()");
$end=strpos($source, "\n\tfunction render_api(", $start);
$method=substr($source,$start,$end-$start);
$stateStart=strpos($source,"\tfunction mark_items_as_read(");
$stateEnd=strpos($source,"\n\tfunction mark_feeds_as_sparks(",$stateStart);
$states=substr($source,$stateStart,$stateEnd-$stateStart);
class OracleDone extends Exception { public $value; public function __construct($value){$this->value=$value;} }
class OracleBoundary {
 public $cfg; public $prefs=['use_celsius'=>false,'ui'=>['section'=>0]]; public $page=1; public $links_by_degrees=[]; public $db=['prefix'=>'']; public $pdo;
 function __construct($input) {
  $this->cfg=['email'=>$input['email'],'password'=>$input['password']];
  $this->pdo=new PDO('sqlite::memory:'); $this->pdo->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);
  foreach($input['tables'] as $table=>$rows) {
   $definitions=$input['columns'][$table];
   $this->pdo->exec('CREATE TABLE "'.$table.'" ('.join(',',$definitions).')');
   foreach($rows as $row) {
    $columns=array_keys($row); $stmt=$this->pdo->prepare('INSERT INTO "'.$table.'" ('.join(',',$columns).') VALUES ('.join(',',array_fill(0,count($columns),'?')).')');
    $stmt->execute(array_values($row));
   }
  }
 }
 function prepare_sql($query,...$args) { foreach($args as $arg) { $offset=strpos($query,'?'); $query=substr_replace($query,$arg===null?'NULL':$this->pdo->quote((string)$arg),$offset,1); } return $query; }
 function query($query) { return $this->pdo->exec($query); }
 function get_all($table,$where=1) { return $this->pdo->query('SELECT * FROM "'.$table.'" WHERE '.$where)->fetchAll(PDO::FETCH_ASSOC); }
 function get_col($column,$table,$where=1) { return $this->pdo->query('SELECT "'.$column.'" FROM "'.$table.'" WHERE '.$where)->fetchColumn(); }
 function get_cols($column,$table,$where=1) { return $this->pdo->query('SELECT "'.$column.'" FROM "'.$table.'" WHERE '.$where)->fetchAll(PDO::FETCH_COLUMN); }
 function get_count($table) { return (int)$this->pdo->query('SELECT count(*) FROM "'.$table.'"')->fetchColumn(); }
 function title($feed) { return $feed['title']; }
 function build_links() { throw new Exception('Hot requires its independent semantic oracle'); }
 function render_api($data,$format) { throw new OracleDone($data); }
}
// PHP 8 removed the source's array-first join overload. A namespaced adapter
// restores that call convention while leaving the extracted method text intact.
eval('namespace FeverOracle; function join($a,$b){return is_array($a)?implode($b,$a):implode($a,$b);} class Oracle extends \\OracleBoundary {'.$method.$states.'}');
require $input['serializer'];
$_GET=$input['query']; $_POST=$input['form'];
try { (new \FeverOracle\Oracle($input))->route_api(); } catch(OracleDone $result) {
 echo json_encode(['data'=>$result->value,'json'=>array_to_json($result->value),'xml'=>array_to_xml($result->value,'response')],JSON_THROW_ON_ERROR);
}
`;

test('isolated populated API, reader, publication and integration parity', { skip: !enabled, timeout: 1_200_000 }, async t => {
  verifyOracleSource();
  assert.equal(process.versions.node.split('.')[0], '24');
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, endpoint, 'Refusing every other database branch');
  assert.equal(process.env.FEVER_BASE_URL, 'http://localhost:3108/fever');
  const pool = getPool();
  const connections = new Set<Client>();
  pool.on('connect', client => {
    connections.add(client);
    // Bound a test transport outage independently of PostgreSQL's server-side
    // statement timeout. An idle pool connection expires after 30 seconds.
    const socket = (client as unknown as { connection: { stream: { setTimeout(ms: number, onTimeout: () => void): void; destroy(error: Error): void } } }).connection.stream;
    socket.setTimeout(45_000, () => socket.destroy(Object.assign(new Error('Parity fixture database transport timed out.'), { code: 'PARITY_DB_TIMEOUT' })));
  });
  pool.on('remove', client => connections.delete(client));
  const target = await pool.connect();
  try { await assertTarget(target, process.env.DATABASE_URL!, fingerprint); }
  finally { target.release(); }
  const sql = (text: string, values?: unknown[]) => pool.query(text, values);
  assert.equal((await sql('SELECT count(*)::int AS count FROM owner')).rows[0].count, 0, 'Refusing to replace an existing owner');
  const owner = { id: 1, email: 'parity-synthetic@example.test' };
  const password = randomBytes(24).toString('base64url');
  const digest = createHash('md5').update(`${owner.email}:${password}`).digest('hex');
  const base = process.env.FEVER_BASE_URL!;
  const results: Array<{ name: string; details: Record<string, unknown> }> = [];
  const runCase = (name: string, work: () => Promise<void>) => t.test(name, { skip: !!process.env.FEVER_PARITY_CASE && !name.includes(process.env.FEVER_PARITY_CASE) }, work);
  const source = resolve(sourceRoot, 'fever.php'), serializer = resolve(sourceRoot, 'api.php');
  const sourceHash = sha(await readFile(source)), serializerHash = sha(await readFile(serializer));
  const implementationHashes = Object.fromEntries(await Promise.all(['tests/parity-integrations.test.ts', 'tests/parity-contracts.test.ts', 'lib/compat/fever.ts', 'lib/compat/serialize.ts', 'lib/integrations/opml.ts', 'lib/integrations/rss.ts', 'lib/integrations/media.ts', 'lib/integrations/sharing.ts'].map(async path => [path, sha(await readFile(path))])));
  const startedAt = new Date().toISOString();
  const received: Array<{ path: string; authorization: string | undefined }> = [];
  const image = Buffer.from('R0lGODlhAQABAIAAAObm5gAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  const mediaServer = http.createServer((request, response) => {
    received.push({ path: request.url!, authorization: request.headers.authorization });
    if (request.url === '/redirect.gif') { response.writeHead(302, { location: `http://localhost:${(mediaServer.address() as { port: number }).port}/other.gif` }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'image/gif' }); response.end(image);
  });
  mediaServer.listen(0, '127.0.0.1'); await once(mediaServer, 'listening');
  const mediaOrigin = `http://127.0.0.1:${(mediaServer.address() as { port: number }).port}`;
  process.env.FEVER_ALLOWED_PRIVATE_ORIGINS = mediaOrigin;
  let ownsOwner = false;
  let cleanup = false;
  t.after(async () => {
    try {
      if (ownsOwner) {
        assert.equal((await sql('SELECT email FROM owner WHERE id=1')).rows[0]?.email, owner.email);
        await sql('DELETE FROM owner WHERE id=1 AND email=$1', [owner.email]);
        await sql("UPDATE installation SET status='uninitialized',setup_closed=false,base_url=NULL WHERE id=1 AND base_url=$1", [base]);
        assert.equal((await sql('SELECT count(*)::int AS count FROM owner')).rows[0].count, 0);
        cleanup = true;
      }
    } finally {
      await new Promise<void>((resolve, reject) => mediaServer.close(error => error ? reject(error) : resolve()));
      // Only idle, settled test connections are closed here. Use the reviewed
      // bounded TLS shutdown before ending the pool on Neon.
      for (const connection of connections) await closeTarget(connection);
      await closeDatabase();
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(resolve(evidenceDirectory, 'integration-receipt.json'), JSON.stringify({
        format: 1, startedAt, completedAt: new Date().toISOString(), node: process.versions.node,
        postgres: '18.6', region: 'aws-us-west-2', branch: 'br-purple-firefly-aro3bi9g', endpoint, fingerprint,
        canonicalUrl: base, targetIsolated: true, fixtureCleanup: cleanup,
        source: { file: 'firewall/app/libs/fever.php', sha256: sourceHash }, serializer: { file: 'firewall/app/libs/api.php', sha256: serializerHash },
        php: execFileSync(phpExecutable, ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' }),
        oracleBoundary: 'Actual source route_api and mutation methods, source JSON/XML serializers; fixture-only PDO SQLite query adapter, PHP 8 array-first join compatibility function, nonempty feed title shim, no Hot shim or legacy MySQL server.',
        implementationHashes, selection: process.env.FEVER_PARITY_CASE ?? 'all', expectedCaseCount: 8, passedCaseCount: results.length,
        allCasesPassed: !process.env.FEVER_PARITY_CASE && results.length === 8 && cleanup,
        passedCases: results, limitations: ['Direct Request handlers are not a deployed Next proxy test.', 'A protocol harness is not an actual Fever-compatible client.', 'Synthetic fixtures do not prove reconciliation of a production data snapshot.', 'Hot parity belongs to a separate test lane.'],
      }, null, 2) + '\n');
    }
  });
  await initializeInstallation({ token: process.env.FEVER_SETUP_TOKEN, email: owner.email, password, useCelsius: false, baseUrl: base });
  ownsOwner = true;
  await sql("INSERT INTO groups(id,owner_id,title) VALUES (11,1,'Parity A'),(12,1,'Parity B')");
  const urls = ['https://example.test/feed.xml', 'https://spark.example.test/feed.xml', `${mediaOrigin}/feed.xml`, 'https://signed.example.test/feed.xml?access_token=synthetic-private-token'];
  const seedFeeds = urls.map((url, i) => ({ id: i + 11, owner_id: 1, url, original_url: url, canonical_url: normalizeUrl(url), url_key: canonicalUrlKey(normalizeUrl(url)), title: `Parity Feed ${i + 1}`, site_url: `https://example.test/site/${i}`, is_spark: i === 1, requires_auth: i === 2 }));
  await sql('INSERT INTO feeds(id,owner_id,url,original_url,canonical_url,url_key,title,site_url,is_spark,requires_auth) SELECT id,owner_id,url,original_url,canonical_url,url_key,title,site_url,is_spark,requires_auth FROM jsonb_to_recordset($1::jsonb) AS x(id bigint,owner_id bigint,url text,original_url text,canonical_url text,url_key text,title text,site_url text,is_spark boolean,requires_auth boolean)', [JSON.stringify(seedFeeds)]);
  await sql('INSERT INTO feed_groups(feed_id,group_id) VALUES(11,11),(11,12),(12,11),(13,12),(14,12)');
  await sql('INSERT INTO feed_fetch_state(feed_id,last_refreshed_at,last_updated_at) SELECT id,1700000000+id,1700000000+id FROM feeds');
  const epoch = 1_780_000_000;
  const seedItems = Array.from({ length: 132 }, (_, index) => {
    const feedId = index < 125 ? 11 : index < 128 ? 12 : index < 130 ? 13 : 14;
    const title = `Parity item ${String(index + 1).padStart(3, '0')} & ไทย 🚀`;
    const html = `<p>${title.replace(/&/g, '&amp;')}</p>`;
    return { id: 1001 + index, feed_id: feedId, identity_key: sha(`parity-${index}`), title, author: 'Synthetic author', raw_html: html, html, search_text: title, url: `https://example.test/article/${index}`, canonical_url: `https://example.test/article/${index}`, published_at: epoch + Math.floor(index / 2), added_at: epoch + index, read_at: index % 3 === 0 ? epoch + 500 : 0, is_saved: index % 2 === 0 };
  });
  await sql('INSERT INTO items(id,feed_id,identity_key,title,author,raw_html,html,search_text,url,canonical_url,published_at,added_at,read_at,is_saved) SELECT id,feed_id,identity_key,title,author,raw_html,html,search_text,url,canonical_url,published_at,added_at,read_at,is_saved FROM jsonb_to_recordset($1::jsonb) AS x(id bigint,feed_id bigint,identity_key text,title text,author text,raw_html text,html text,search_text text,url text,canonical_url text,published_at bigint,added_at bigint,read_at bigint,is_saved boolean)', [JSON.stringify(seedItems)]);
  for (const table of ['groups', 'feeds', 'items']) await sql(`SELECT setval(pg_get_serial_sequence('${table}','id'), (SELECT max(id) FROM ${table}), true)`);
  const fever = async (query: string, form: Record<string, string> = {}) => {
    const response = await handleFever(new Request(`${base}/?api&${query}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: digest, ...form }) }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /private, no-store/);
    const data = await response.json(); assert.equal(data.auth, 1); return data;
  };
  const snapshot = async () => ({
    groups: (await sql('SELECT id::int,title FROM groups ORDER BY id')).rows,
    feeds: (await sql('SELECT f.id::int,f.title,f.url,f.site_url,f.favicon_id::int,(CASE WHEN f.is_spark THEN 1 ELSE 0 END) AS is_spark,s.last_refreshed_at::int AS last_refreshed_on_time,s.last_updated_at::int AS last_updated_on_time FROM feeds f JOIN feed_fetch_state s ON s.feed_id=f.id ORDER BY f.id')).rows,
    feeds_groups: (await sql('SELECT feed_id::int,group_id::int FROM feed_groups ORDER BY group_id,feed_id')).rows,
    items: (await sql('SELECT id::int,feed_id::int,title,author,raw_html AS description,url AS link,read_at::int AS read_on_time,(CASE WHEN is_saved THEN 1 ELSE 0 END) AS is_saved,published_at::int AS created_on_time,added_at::int AS added_on_time FROM items ORDER BY id')).rows,
    favicons: (await sql("SELECT id::int,mime_type||';base64,'||encode(data,'base64') AS cache FROM favicons ORDER BY id")).rows,
  });
  const columns = {
    groups: ['id INTEGER', 'title TEXT'],
    feeds: ['id INTEGER', 'title TEXT', 'url TEXT', 'site_url TEXT', 'favicon_id INTEGER', 'is_spark INTEGER', 'last_refreshed_on_time INTEGER', 'last_updated_on_time INTEGER'],
    feeds_groups: ['feed_id INTEGER', 'group_id INTEGER'],
    items: ['id INTEGER', 'feed_id INTEGER', 'title TEXT', 'author TEXT', 'description TEXT', 'link TEXT', 'read_on_time INTEGER', 'is_saved INTEGER', 'created_on_time INTEGER', 'added_on_time INTEGER'],
    favicons: ['id INTEGER', 'cache TEXT'],
  };
  const oracle = (tables: Awaited<ReturnType<typeof snapshot>>, query: string, form: Record<string, string> = {}) => JSON.parse(execFileSync(phpExecutable, ['-r', phpOracle], {
    input: JSON.stringify({ source, serializer, email: owner.email, password, tables, columns, query: Object.fromEntries(new URLSearchParams(`api&${query}`)), form: { api_key: digest, ...form } }), encoding: 'utf8', maxBuffer: 16_777_216,
  })) as { data: Record<string, unknown>; json: string; xml: string };

  await runCase('actual PHP API route read contracts, selection precedence, 50-item pages and serializers', async () => {
    const tables = await snapshot();
    const queries = ['groups', 'feeds', 'favicons', 'items', 'items&since_id=1050', 'items&max_id=0', 'items&max_id=1080&with_ids=1001&since_id=999999', 'items&with_ids=1001,1002,1110&since_id=999999', 'items&feed_ids=11&group_ids=11', 'items&feed_ids=13&group_ids=11', 'items&group_ids=12', 'items&with_ids=', 'unread_item_ids&saved_item_ids', 'groups&feeds&favicons&items&unread_item_ids&saved_item_ids'];
    for (const query of queries) {
      const legacy = oracle(tables, query);
      const modern = await fever(query);
      assert.deepEqual(modern, legacy.data, query);
      assert.deepEqual(JSON.parse(legacy.json), modern, `source JSON ${query}`);
      assert.deepEqual(parseXml(feverXml(modern as Record<string, FeverValue>)), parseXml(legacy.xml), `source XML ${query}`);
    }
    const seen: number[] = [];
    for (let since = 0; ;) {
      const page = await fever(`items&since_id=${since}`);
      seen.push(...page.items.map((item: { id: number }) => item.id));
      if (page.items.length < 50) break;
      since = page.items.at(-1).id;
    }
    assert.deepEqual(seen, seedItems.map(item => item.id));
    const reverse: number[] = [];
    for (let max = 0; ;) {
      const page = await fever(`items&max_id=${max}`);
      reverse.push(...page.items.map((item: { id: number }) => item.id));
      if (page.items.length < 50) break;
      max = page.items.at(-1).id;
    }
    assert.deepEqual(reverse, [...seen].reverse());
    results.push({ name: 'source API differential', details: { readQueries: queries.length, serializers: ['source JSON', 'parsed source XML'], items: seen.length, ascendingPages: 3, descendingPages: 3, completeUnreadIds: tables.items.filter(item => item.read_on_time === 0).length, completeSavedIds: tables.items.filter(item => item.is_saved === 1).length } });
  });

  await runCase('reader cursor continuity over shrinking unread/all/saved/search lists in both orders', async () => {
    const pageCounts: Record<string, number> = {};
    for (const sortOrder of [0, 1]) {
      await savePreferences(owner, { sortOrder, perPage: 20 });
      for (const section of ['kindling', 'saved', 'search'] as const) {
        await sql('UPDATE items SET read_at=0 WHERE feed_id=11');
        const wanted = seedItems.filter(item => item.feed_id === 11 && (section !== 'saved' || item.is_saved)).sort((a, b) => sortOrder === 1 ? a.published_at - b.published_at || a.id - b.id : b.published_at - a.published_at || b.id - a.id).map(item => item.id);
        const receivedIds: number[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const view = await getReaderView(owner, { section, feedId: 11, groupId: 0, showFeeds: true, showRead: section !== 'kindling', search: section === 'search' ? 'Parity item' : '', cursor, deviceKey: 'parity' }, { capture: false });
          receivedIds.push(...view.items.map(item => item.id)); pages++;
          if (section === 'kindling') await mutateItems(owner, 'read', view.items.map(item => item.id), { origin: 'api' });
          if (pages === 1) {
            // A later arrival has a higher ID, including when it sorts behind the cursor.
            await sql('INSERT INTO items(feed_id,identity_key,title,raw_html,html,search_text,url,canonical_url,published_at,added_at) VALUES(11,$1,$2,$3,$3,$2,$4,$4,$5,$5)', [sha(`arrival-${sortOrder}-${section}`), 'Parity item concurrent arrival', '<p>Arrival</p>', 'https://example.test/concurrent', sortOrder === 1 ? epoch + 1000 : epoch]);
          }
          cursor = view.nextCursor ?? undefined;
          assert.equal(view.hasMore, !!cursor);
        } while (cursor);
        assert.deepEqual(receivedIds, wanted, `${section}/${sortOrder}`);
        assert.equal(new Set(receivedIds).size, wanted.length);
        assert.ok(pages >= 3);
        pageCounts[`${section}/${sortOrder}`] = pages;
        await sql('DELETE FROM items WHERE feed_id=11 AND id>1132');
      }
    }
    results.push({ name: 'reader pagination', details: { pageCounts, shrinkingUnread: true, publicationTies: true, concurrentArrivalsExcluded: true } });
  });

  await runCase('source mutation matrix preserves cutoff, Spark groups, automatic ID lists and link no-ops', async () => {
    const cases: Array<Record<string, string>> = [
      { mark: 'item', as: 'read', id: '1002' }, { mark: 'item', as: 'unread', id: '1001' },
      { mark: 'item', as: 'saved', id: '1002' }, { mark: 'item', as: 'unsaved', id: '1001' },
      { mark: 'feed', as: 'read', id: '11', before: String(epoch + 40) },
      { mark: 'group', as: 'read', id: '0', before: String(epoch + 126) },
      { mark: 'group', as: 'read', id: '-1', before: String(epoch + 127) },
      { mark: 'group', as: 'read', id: '11', before: String(epoch + 126) },
      { mark: 'feed', as: 'spark', id: '11' }, { mark: 'feed', as: 'unspark', id: '12' },
      { mark: 'link', as: 'saved', id: '99999' }, { mark: 'link', as: 'unsaved', id: '99999' },
    ];
    for (const form of cases) {
      await sql('UPDATE items SET read_at=CASE WHEN (id-1001)%3=0 THEN $1 ELSE 0 END,is_saved=((id-1001)%2=0)', [epoch + 500]);
      await sql('UPDATE feeds SET is_spark=(id=12)');
      const tables = await snapshot();
      const legacy = oracle(tables, 'unread_item_ids&saved_item_ids&feeds', form);
      const modern = await fever('unread_item_ids&saved_item_ids&feeds', form);
      assert.deepEqual(modern, legacy.data, `${form.mark}/${form.as}/${form.id}`);
      if (form.as === 'saved' && form.mark === 'item') assert.equal((await sql('SELECT read_at::int FROM items WHERE id=1002')).rows[0].read_at, 0, 'API saving must not mark unread content read');
    }
    // Source without before issues malformed SQL for a group; modern compat
    // deliberately returns an unchanged set instead of causing an SQL failure.
    const before = await fever('unread_item_ids');
    const missing = await fever('', { mark: 'group', as: 'read', id: '0' });
    assert.equal(missing.unread_item_ids, before.unread_item_ids);
    const zero = await fever('', { mark: 'group', as: 'read', id: '0', before: '0' });
    assert.equal(zero.unread_item_ids, before.unread_item_ids);
    const unsupported = await fever('', { mark: 'constructor', as: 'read', id: '1001' });
    assert.equal('unread_item_ids' in unsupported, false);
    results.push({ name: 'source mutation differential', details: { cases: cases.length, strictCutoff: true, sparkMembershipHidden: true, linkSaveNoOp: true, missingOrZeroBeforeSafeNoOp: true } });
  });

  await runCase('enabled Saved RSS publishes the newest 30 with protected and signed-URL privacy policies', async () => {
    await sql('UPDATE feeds SET is_spark=(id=12)');
    await sql('UPDATE items SET is_saved=true');
    const secretUrl = urls[3];
    await sql('UPDATE items SET url=$1,raw_html=$2,html=$2 WHERE id=1132', [`${secretUrl}#article`, `<p>Secret subscription</p><a href="${secretUrl}">private</a><a href="?access_token=synthetic-private-token#relative">relative private</a><img src="${secretUrl}#image"><img src="#relative-image"><video poster="${secretUrl}#poster"><source src="${secretUrl}"></video>`]);
    await assert.rejects(savedRss(), hasCode('RSS_DISABLED'));
    for (const shareProtected of [false, true]) {
      await savePreferences(owner, { share: true, shareProtected });
      const response = await savedRss();
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const text = await response.text();
      assert.doesNotMatch(text, /synthetic-private-token|access_token/);
      const channel = parseXml(text).children.find(node => node.name === 'channel')!;
      const entries = channel.children.filter(node => node.name === 'item');
      assert.equal(entries.length, 30);
      const expected = (await sql('SELECT i.id::int FROM items i JOIN feeds f ON f.id=i.feed_id WHERE i.is_saved AND ($1::boolean OR NOT f.requires_auth) ORDER BY i.published_at DESC,i.id DESC LIMIT 30', [shareProtected])).rows.map(row => row.id);
      assert.deepEqual(entries.map(node => Number(node.children.find(child => child.name === 'guid')!.text.split('@')[0])), expected);
      for (const entry of entries) assert.match(entry.children.find(child => child.name === 'guid')!.text, /^\d+@localhost\/fever$/);
      assert.equal(expected.some(id => id === 1129 || id === 1130), shareProtected);
    }
    await savePreferences(owner, { share: false });
    await assert.rejects(rootCompatibility(new Request(`${base}/?rss=saved`)), hasCode('RSS_DISABLED'));
    results.push({ name: 'Saved RSS', details: { publicEntryLimit: 30, stableGuidsUnderBasePath: true, protectedFeedExcludedByDefault: true, explicitProtectedPublicationTested: true, signedSubscriptionUrlRedactedFromLinkAndMedia: true, disableEffectiveImmediately: true } });
  });

  await runCase('OPML full import/export roundtrip retains multi-group subscriptions and Sparks', async () => {
    await sql('UPDATE feeds SET is_spark=(id=12)');
    const literalEntityUrl = 'https://example.test/entities.xml?a=1&amp;b=2';
    await createFeed(owner, { url: literalEntityUrl, title: 'Fish &amp; Chips', groupIds: [11] });
    const original = await getNavigation(owner);
    const exported = await exportOpml(owner, { groupIds: [], flatten: false, includeSparks: true });
    const parsed = parseOpml(exported.xml, true);
    assert.ok(parsed.feeds.some(feed => feed.isSpark && feed.url === urls[1]));
    assert.ok(parsed.feeds.some(feed => feed.url === literalEntityUrl && feed.title === 'Fish &amp; Chips'), 'Export/reimport preserves literal entity text in both titles and subscription URLs');
    assert.equal(parsed.feeds.filter(feed => feed.url === urls[0]).length, 3, 'All plus two groups retain multi-membership');
    const counts = (await sql('SELECT (SELECT count(*) FROM feeds)::int AS feeds,(SELECT count(*) FROM groups)::int AS groups,(SELECT count(*) FROM feed_groups)::int AS memberships')).rows[0];
    const result = await importOpml(owner, exported.xml, true);
    assert.equal(result.feedsAdded, 0); assert.equal(result.groupsAdded, 0); assert.equal(result.membershipsAdded, 0);
    assert.deepEqual((await sql('SELECT (SELECT count(*) FROM feeds)::int AS feeds,(SELECT count(*) FROM groups)::int AS groups,(SELECT count(*) FROM feed_groups)::int AS memberships')).rows[0], counts);
    const after = await getNavigation(owner);
    assert.deepEqual(after.feeds.map(feed => [feed.id, [...feed.groupIds].sort(), feed.isSpark]), original.feeds.map(feed => [feed.id, [...feed.groupIds].sort(), feed.isSpark]));
    const aliasGroup = await createGroup(owner, { title: 'Straße' });
    const alias = await importOpml(owner, '<opml><body><outline text="Strasse"><outline text="Existing" xmlUrl="https://example.test/feed.xml"/></outline><outline text="Párity A"><outline text="Existing" xmlUrl="https://example.test/feed.xml"/></outline></body></opml>', true);
    assert.equal(alias.feedsAdded, 0); assert.equal(alias.groupsAdded, 0); assert.equal(alias.membershipsAdded, 1);
    assert.equal((await sql('SELECT count(*)::int AS count FROM feed_groups WHERE feed_id=11 AND group_id=$1', [aliasGroup.id])).rows[0].count, 1);
    const nested = '<opml><head><title>Parity Imported</title></head><body><outline text="Parent"><outline text="Nested"><outline text="New" xmlUrl="https://example.test/new-parity.xml"/></outline></outline><outline text="Sparks"><outline text="Existing Spark" xmlUrl="https://spark.example.test/feed.xml"/></outline></body></opml>';
    const nestedResult = await importOpml(owner, nested, true);
    assert.equal(nestedResult.feedsAdded, 1); assert.equal(nestedResult.groupsAdded, 2);
    const flattened = parseOpml(nested, false);
    assert.deepEqual(flattened.groups, ['Parity Imported (imported)']);
    assert.ok(flattened.feeds.every(feed => feed.group === 'Parity Imported (imported)'));
    const one = await exportOpml(owner, { groupIds: [11], flatten: false, includeSparks: false });
    assert.equal(parseOpml(one.xml, true).groups.length, 0, 'Single selected group export is flattened');
    const flat = parseOpml((await exportOpml(owner, { groupIds: [], flatten: true, includeSparks: false })).xml, true);
    assert.equal(flat.feeds.filter(feed => feed.url === urls[0]).length, 1);
    const collision = await createGroup(owner, { title: 'Parity A' }); assert.equal(collision.created, false);
    assert.deepEqual(await createGroup(owner, { title: 'Kindling' }), { id: 0, created: false });
    const duplicate = await createFeed(owner, { url: urls[0], groupIds: [12] }); assert.equal(duplicate.created, false);
    results.push({ name: 'OPML integration', details: { fullRoundtripExistingInstallation: true, multiGroupMembershipsConserved: true, literalEntityTextAndSubscriptionUrlConserved: true, sparkRoundtrip: true, nestedImport: true, importedTitleFlatten: true, singleGroupExportFlatten: true, allFeedFlattenDeduplication: true, duplicateSubscriptionsAndGroupNames: true, sourceEquivalentAccentAndExpansionGroupAliases: true, kindlingRemainsVirtual: true } });
  });

  await runCase('sharing encodes placeholders, disables unsafe services and blocks private background requests', async () => {
    const item = { title: 'Thai ไทย & # /', url: 'https://example.test/a?q=1&b=2', excerpt: 'A < B\nnext' };
    const expanded = expandSharingTemplate({ name: 'Test', url: 'https://share.example.test/?t=%t&u=%u&e=%e', key: '' }, item);
    const parsed = new URL(expanded.url);
    for (const [key, value] of [['t', item.title], ['u', item.url], ['e', item.excerpt]]) assert.equal(parsed.searchParams.get(key), value);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'https://user:password@example.test/', '#mailto:test@example.test']) assert.throws(() => expandSharingTemplate({ name: 'Unsafe', url, key: '' }, item));
    await savePreferences(owner, { services: [{ name: 'Unsafe', url: 'javascript:alert(1)', key: 'e' }, { name: 'First', url: 'https://example.test/?u=%u', key: 's' }, { name: 'Conflict', url: 'https://example.test/?u=%u', key: 's' }, { name: 'Blocked background', url: `#${mediaOrigin}/should-not-send`, key: '' }] });
    const view = await getReaderView(owner, { section: 'kindling', deviceKey: 'parity' }, { capture: false });
    assert.equal(view.preferences.services[0].enabled, false);
    assert.equal(view.preferences.services[2].enabled, false);
    const count = received.length;
    await assert.rejects(shareItem(owner, view.preferences.services[0].id!, 1001), hasCode('SERVICE_DISABLED'));
    await assert.rejects(shareItem(owner, view.preferences.services[3].id!, 1001), blockedDestination);
    assert.equal(received.length, count, 'Blocked destinations receive no request');
    results.push({ name: 'sharing restrictions', details: { placeholdersDecodedExactly: true, unsafeTemplatesDisabled: true, duplicateShortcutsDisabled: true, backgroundPrivateAddressDeniedEvenWithFeedAllowlist: true, blockedNetworkRequests: 0 } });
  });

  await runCase('media only fetches associated raster URLs and confines feed credentials to the feed origin', async () => {
    await updateFeed(owner, { id: 13, url: urls[2], username: 'parity-user', password: 'parity-password', preventsHotlinking: true });
    const foreign = `http://localhost:${(mediaServer.address() as { port: number }).port}/other.gif`;
    const ownUrl = `${mediaOrigin}/image.gif`;
    await sql('UPDATE items SET raw_html=$1,html=$1 WHERE id=1129', [`<p>Media</p><img src="${ownUrl}"><img src="${foreign}"><img src="${mediaOrigin}/redirect.gif"><img src="${mediaOrigin}/not-image"><video poster="${ownUrl}"></video>`]);
    const count = received.length;
    await assert.rejects(mediaResponse(owner, 1129, `${mediaOrigin}/not-associated.gif`), hasCode('MEDIA_NOT_ASSOCIATED'));
    assert.equal(received.length, count);
    const response = await mediaResponse(owner, 1129, `${ownUrl}#ignored`);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.match(response.headers.get('cache-control') ?? '', /private, no-store/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(received.at(-1)?.authorization, `Basic ${Buffer.from('parity-user:parity-password').toString('base64')}`);
    const sent = received.length;
    await assert.rejects(mediaResponse(owner, 1129, foreign), blockedDestination);
    assert.equal(received.length, sent);
    await assert.rejects(mediaResponse(owner, 1129, `${mediaOrigin}/redirect.gif`), blockedDestination);
    assert.equal(received.length, sent + 1, 'A cross-origin redirect is refused before sending credentials or opening its private destination');
    const icon = await faviconResponse(owner, 999999);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    results.push({ name: 'media and favicon restrictions', details: { nonAssociatedUrlDeniedBeforeNetwork: true, associatedRasterReencodedPng: true, basicAuthenticationSameOrigin: true, crossOriginPrivateFetchDenied: true, crossOriginRedirectDeniedBeforeDestinationRequest: true, missingFaviconFallsBackSafely: true } });
  });

  await runCase('OPML reconstructs representable subscriptions and memberships in an empty fixture', async () => {
    const before = await getNavigation(owner);
    const expected = before.feeds.map(feed => ({ url: feed.url, title: feed.title, isSpark: feed.isSpark,
      groups: feed.isSpark ? [] : before.groups.filter(group => group.id > 0 && feed.groupIds.includes(group.id)).map(group => group.title).sort(),
    })).sort((a, b) => a.url.localeCompare(b.url));
    const exported = await exportOpml(owner, { groupIds: [], flatten: false, includeSparks: true });
    // Every row here belongs to this suite's guarded disposable installation.
    assert.equal((await sql('SELECT email FROM owner WHERE id=1')).rows[0].email, owner.email);
    await sql('DELETE FROM feeds WHERE owner_id=1');
    await sql('DELETE FROM groups WHERE owner_id=1');
    const imported = await importOpml(owner, exported.xml, true);
    assert.equal(imported.feedsAdded, expected.length);
    const after = await getNavigation(owner);
    const actual = after.feeds.map(feed => ({ url: feed.url, title: feed.title, isSpark: feed.isSpark,
      groups: feed.isSpark ? [] : after.groups.filter(group => group.id > 0 && feed.groupIds.includes(group.id)).map(group => group.title).sort(),
    })).sort((a, b) => a.url.localeCompare(b.url));
    assert.deepEqual(actual, expected);
    const empty = await fever('items&unread_item_ids&saved_item_ids');
    assert.deepEqual(empty.items, []); assert.equal(empty.total_items, 0);
    assert.equal(empty.unread_item_ids, ''); assert.equal(empty.saved_item_ids, '');
    const limitations = ['OPML has no article content, read/saved state, credentials or stable IDs.', 'Legacy OPML does not represent hidden Spark group affiliations.'];
    results.push({ name: 'OPML fresh reconstruction', details: { subscriptions: expected.length, groupsAndMembershipsConserved: true, titlesAndUrlsConserved: true, sparkClassificationConserved: true, limitations } });
  });
});

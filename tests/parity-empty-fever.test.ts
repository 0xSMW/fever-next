import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { phpExecutable, sourceRoot, verifyOracleSource } from './hot-oracle';
import type { Client } from 'pg';
import { initializeInstallation } from '../lib/auth/setup';
import { closeDatabase, getPool } from '../lib/db/client';
import { assertTarget, closeTarget } from '../lib/migration/target';
import { createFeed } from '../lib/domain/subscriptions';
import { handleFever } from '../lib/compat/fever';

const enabled = process.env.FEVER_EMPTY_API_TESTS === '1';
const endpoint = 'ep-blue-field-arn6ictb.c-4.us-west-2.aws.neon.tech';
const fingerprint = 'f68fe9974e8638485c07d78598dd895996ac3e651f0eb0edea9824f738a8db54';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const phpOracle = String.raw`
function low($v){return strtolower($v);}
function r($a,$b,$v){return preg_replace($a,$b,$v);}
function h($v){return htmlspecialchars((string)$v,ENT_QUOTES);}
function sr($a,$b,$v){return str_replace($a,$b,$v);}
$input=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$source=file_get_contents($input['source']);
function extract_method($name,$source){
 $start=strpos($source,"\tfunction ".$name.'(');
 if($start===false)throw new Exception('Owning source method is absent');
 $next=strpos($source,"\n\tfunction ",$start+1);
 if($next===false)throw new Exception('Owning source method boundary is absent');
 return substr($source,$start,$next-$start);
}
class Finished extends Exception{public $value;function __construct($value){$this->value=$value;}}
class OracleConnection{public $pdo;public $statement;function __construct(){$this->pdo=new PDO('sqlite::memory:');$this->pdo->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);}function rows(){return $this->statement->fetchAll(PDO::FETCH_ASSOC);}}
class OracleBoundary{
 public $cfg;public $db=['prefix'=>''];public $dbc;
 function __construct($input){
  $this->cfg=['email'=>$input['email'],'password'=>$input['password']];
  $this->dbc=new OracleConnection();$this->dbc->pdo->exec('CREATE TABLE feeds(last_refreshed_on_time INTEGER NOT NULL)');
  foreach($input['epochs'] as $epoch){$statement=$this->dbc->pdo->prepare('INSERT INTO feeds VALUES(?)');$statement->execute([$epoch]);}
 }
 function query($sql){$this->dbc->statement=$this->dbc->pdo->query($sql);return true;}
 function render_api($data,$format){throw new Finished($data);}
}
$methods='';foreach(['route_api','get_col','query_col','query_one'] as $name)$methods.=extract_method($name,$source);
eval('class Oracle extends OracleBoundary{'.$methods.'}');
require $input['serializer'];
$_GET=['api'=>'json'];$_POST=['api_key'=>md5($input['email'].':'.$input['password'])];
try{(new Oracle($input))->route_api();}catch(Finished $result){echo json_encode(['data'=>$result->value,'json'=>array_to_json($result->value),'xml'=>array_to_xml($result->value,'response')],JSON_THROW_ON_ERROR);}
`;

test('source empty Fever metadata preserves false while real zero and populated epochs stay numeric', { skip: !enabled, timeout: 180_000 }, async t => {
  verifyOracleSource();
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, endpoint);
  assert.equal(process.env.FEVER_BASE_URL, 'http://localhost:3108/fever');
  const pool = getPool(), connections = new Set<Client>();
  pool.on('connect', client => connections.add(client));
  pool.on('remove', client => connections.delete(client));
  const target = await pool.connect();
  try { await assertTarget(target, process.env.DATABASE_URL!, fingerprint); } finally { target.release(); }
  const sql = (query: string, values?: unknown[]) => pool.query(query, values);
  assert.equal((await sql('SELECT count(*)::int AS count FROM owner')).rows[0].count, 0, 'Refusing an initialized installation');
  const owner = { id: 1, email: 'parity-empty-api@example.test' };
  const password = randomBytes(24).toString('base64url');
  const digest = createHash('md5').update(`${owner.email}:${password}`).digest('hex');
  const base = process.env.FEVER_BASE_URL!;
  const source = resolve(sourceRoot, 'fever.php'), serializer = resolve(sourceRoot, 'api.php');
  const sourceHash = sha(await readFile(source)), serializerHash = sha(await readFile(serializer));
  const implementationHashes = Object.fromEntries(await Promise.all(['lib/compat/fever.ts', 'lib/compat/serialize.ts', 'tests/parity-empty-fever.test.ts'].map(async path => [path, sha(await readFile(path))])));
  const cases: Array<{ name: string; epochs: number[]; expected: false | number; jsonMatched: boolean; xmlMatched: boolean }> = [];
  let ownsOwner = false, cleaned = false;
  t.after(async () => {
    try {
      if (ownsOwner) {
        assert.equal((await sql('SELECT email FROM owner WHERE id=1')).rows[0]?.email, owner.email);
        await sql('DELETE FROM owner WHERE id=1 AND email=$1', [owner.email]);
        await sql("UPDATE installation SET status='uninitialized',setup_closed=false,base_url=NULL WHERE id=1 AND base_url=$1", [base]);
        assert.equal((await sql('SELECT count(*)::int AS count FROM owner')).rows[0].count, 0);
        cleaned = true;
      }
    } finally {
      for (const connection of connections) await closeTarget(connection);
      await closeDatabase();
      const directory = resolve(process.env.FEVER_TEST_EVIDENCE_DIR ?? 'tests/.artifacts/parity');
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, 'empty-api-receipt.json'), JSON.stringify({ format: 1, completedAt: new Date().toISOString(), endpoint, fingerprint,
        node: process.versions.node, php: execFileSync(phpExecutable, ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' }),
        source: { file: 'firewall/app/libs/fever.php', sha256: sourceHash, methods: ['route_api', 'get_col', 'query_col', 'query_one'] },
        serializer: { file: 'firewall/app/libs/api.php', sha256: serializerHash },
        oracleBoundary: 'Unchanged source methods and source serializers; only query()/dbc->rows() are adapted to a fixture-only PDO SQLite table.',
        implementationHashes, cases, allCasesPassed: cases.length === 3 && cleaned, fixtureCleanup: cleaned,
        closesDifference: 'Empty subscriptions return JSON false and an empty XML element; a stored epoch zero remains JSON numeric 0 and XML text 0.',
        mainInstallationMutations: false,
      }, null, 2) + '\n');
    }
  });
  await initializeInstallation({ token: process.env.FEVER_SETUP_TOKEN, email: owner.email, password, useCelsius: false, baseUrl: base });
  ownsOwner = true;
  const check = async (name: string, epochs: number[], expected: false | number) => {
    const legacy = JSON.parse(execFileSync(phpExecutable, ['-r', phpOracle], { encoding: 'utf8', input: JSON.stringify({ source, serializer, email: owner.email, password, epochs }) }));
    assert.equal(legacy.data.last_refreshed_on_time, expected, 'The owning PHP source must establish the expected value');
    for (const format of ['json', 'xml'] as const) {
      const response = await handleFever(new Request(`${base}/?api=${format}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: digest }) }));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control') ?? '', /private, no-store/);
      assert.equal(await response.text(), legacy[format], `${name}/${format}`);
    }
    cases.push({ name, epochs, expected, jsonMatched: true, xmlMatched: true });
  };
  await check('no subscriptions', [], false);
  const feed = await createFeed(owner, { url: 'https://example.test/empty-api.xml', title: 'Empty API fixture' });
  await check('subscribed but never refreshed', [0], 0);
  await sql('UPDATE feed_fetch_state SET last_refreshed_at=1700000000 WHERE feed_id=$1', [feed.id]);
  await check('populated refresh epoch', [1_700_000_000], 1_700_000_000);
});

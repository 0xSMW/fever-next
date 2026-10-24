import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

// Original source is private operator input, never an implicit parent checkout.
export const sourceHashes = { "util.php": "6b9b71b06e8b021c4023fdbca1cd12ff8afc31ee6ac463aa676471e77d7b61c9", "fever.php": "f676e28ec1a4177e2877b0e6cc7427be5aec953979bbfb6ddb7fa6e0ae5d3fa0" };
export const phpExecutable = process.env.FEVER_PHP_BIN || "php";
export const sourceRoot = process.env.FEVER_PHP_SOURCE_ROOT ? resolve(process.env.FEVER_PHP_SOURCE_ROOT) + sep : "";
const fixturePath = new URL("./fixtures/php-oracle.json", import.meta.url);
const liveOracle = process.env.FEVER_PHP_ORACLE === "1" || process.env.FEVER_HOT_TESTS === "1";
const capture = process.env.FEVER_CAPTURE_PHP_ORACLE === "1";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type OracleFixture = {
  sourceHashes: Record<string, string>;
  harnessSha256: string;
  phpVersion: string;
  timezone: string;
  cases: Record<string, { op: string; input: Record<string, unknown>; output: unknown }>;
};
if (capture && !liveOracle) throw new Error("Capture requires FEVER_PHP_ORACLE=1 and the original source directory.");
let fixture: OracleFixture | undefined;
let sourceVerified = false;
export function verifyOracleSource() {
  if (!sourceRoot || !isAbsolute(process.env.FEVER_PHP_SOURCE_ROOT!)) throw new Error("Live PHP comparisons require FEVER_PHP_SOURCE_ROOT as an absolute path to the original app/libs directory.");
  if (!sourceVerified) {
    for (const [name, expected] of Object.entries(sourceHashes)) {
      const actual = createHash("sha256").update(readFileSync(sourceRoot + name)).digest("hex");
      if (actual !== expected) throw new Error(`Oracle source changed: ${name}; review and freeze provenance explicitly.`);
    }
    sourceVerified = true;
  }
}
export function oracleProvenance() {
  if (liveOracle) {
    verifyOracleSource();
    return { sourceHashes, harnessSha256: digest(phpHarness), phpVersion: execFileSync(phpExecutable, ["-r", "echo PHP_VERSION;"], { encoding: "utf8" }), timezone: "UTC", mode: "live" };
  }
  const frozen = loadFixture();
  return { sourceHashes: frozen.sourceHashes, harnessSha256: frozen.harnessSha256, phpVersion: frozen.phpVersion, timezone: frozen.timezone, mode: "frozen" };
}
function loadFixture() {
  fixture ??= JSON.parse(readFileSync(fixturePath, "utf8"));
  if (digest(fixture!.sourceHashes) !== digest(sourceHashes) || fixture!.harnessSha256 !== digest(phpHarness)) throw new Error("PHP oracle fixture provenance changed; regenerate and review the corpus explicitly.");
  return fixture!;
}

/**
 * Execute functions extracted verbatim from the retained PHP source, without
 * loading its application bootstrap, credentials, network, or database. The
 * SQL adapter below supplies frozen arrays to the source build_links method.
 * Only its time() call is replaced to inject the test clock. SQL ordering ties
 * are deliberately not used for PHP parity claims (the new ID/CRC tie rules
 * have separate deterministic assertions).
 */
export const phpHarness = String.raw`
error_reporting(E_ALL & ~E_DEPRECATED);
date_default_timezone_set('UTC');
$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
function source_function($path, $name) {
  $tokens = token_get_all(file_get_contents($path));
  for ($i = 0; $i < count($tokens); $i++) {
    if (!is_array($tokens[$i]) || $tokens[$i][0] !== T_FUNCTION) continue;
    $j = $i + 1;
    while (is_array($tokens[$j]) && $tokens[$j][0] === T_WHITESPACE) $j++;
    if (!is_array($tokens[$j]) || $tokens[$j][1] !== $name) continue;
    $code = ''; $depth = 0; $started = false;
    for (; $i < count($tokens); $i++) {
      $token = $tokens[$i]; $code .= is_array($token) ? $token[1] : $token;
      if ($token === '{' || (is_array($token) && in_array($token[0], [T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES]))) { $depth++; $started = true; }
      if ($token === '}' && --$depth === 0 && $started) return $code;
    }
  }
  throw new Exception('Missing source function '.$name);
}
$util = $input['root'].'util.php'; $fever = $input['root'].'fever.php';
foreach (['low','sr','r','m','ma','checksum','is_https','resolve','true_url','normalize_url','callback_low','strip_tags_sane','array_frequency','key_remap','get_safe_html_translation_table','html_entity_decode_utf8','callback_code2utf_hexdec','callback_code2utf','code2utf'] as $name) eval(source_function($util, $name));
// PHP 8.5 removed utf8_encode; this equivalent ISO-8859-1 byte conversion is
// the only runtime compatibility shim. Ranking/URL functions remain source.
if (!function_exists('utf8_encode')) { function utf8_encode($s) { return mb_convert_encoding($s, 'UTF-8', 'ISO-8859-1'); } }
$methods = '';
foreach (['parse_links','weight_links','build_blacklist_regexp','build_links','title'] as $name) {
  $method = source_function($fever, $name);
  if ($name === 'build_links') $method = str_replace('$now'."\t\t".'= time();', '$now = $this->frozenNow;', $method);
  $methods .= $method;
}
eval('#[AllowDynamicProperties] class Oracle { public $prefs; public $rows; public $itemRows; public $page; public $db = ["prefix"=>""]; public $frozenNow; public $links_by_degrees = []; public $scores = []; '.$methods.'
  function prepare_sql($sql, $id) { return str_replace("?", (string)$id, $sql); }
  function get_all($table, $sql) {
    if ($table === "items") return $this->itemRows;
    $rows = $this->rows;
    if (preg_match("/\\x60feed_id\\x60 = ([0-9]+)/", $sql, $m)) $rows = array_values(array_filter($rows, fn($r) => $r["feed_id"] == $m[1]));
    if (preg_match("/\\x60url_checksum\\x60 IN \\(([^)]+)\\)/", $sql, $m)) { $ids = explode(",", $m[1]); $rows = array_values(array_filter($rows, fn($r) => in_array($r["url_checksum"], $ids))); }
    if (str_contains($sql, "\\x60is_local\\x60=1")) $rows = array_values(array_filter($rows, fn($r) => $r["is_local"] && $r["is_item"]));
    if (str_contains($sql, "\\x60is_blacklisted\\x60 = 0")) $rows = array_values(array_filter($rows, fn($r) => !$r["is_blacklisted"]));
    foreach ([">", "<"] as $op) if (preg_match("/\\x60created_on_time\\x60 ".$op." (-?[0-9]+)/", $sql, $m)) $rows = array_values(array_filter($rows, fn($r) => $op === ">" ? $r["created_on_time"] > $m[1] : $r["created_on_time"] < $m[1]));
    $asc = str_contains($sql, " ASC"); usort($rows, fn($a,$b) => $asc ? $a["created_on_time"] <=> $b["created_on_time"] : ($b["created_on_time"] <=> $a["created_on_time"] ?: $b["is_item"] <=> $a["is_item"]));
    return $rows;
  }
  function query_all($sql) {
    $scores = [];
    foreach ($this->get_all("links", $sql) as $row) if ($row["is_first"]) { $id = $row["url_checksum"]; $scores[$id] = ($scores[$id] ?? 0) + 1.25 / pow(2, $row["weight"]); }
    arsort($scores); $this->scores = $scores; $rows = []; foreach ($scores as $id=>$weight) $rows[] = ["url_checksum"=>$id,"weight"=>$weight];
    if (!preg_match("/LIMIT ([0-9]+), ([0-9]+)/", $sql, $m)) throw new Exception("Unsupported source scoring query");
    return array_slice($rows, (int)$m[1], (int)$m[2]);
  }
  function query($sql) {
    if (!preg_match("/SET \\x60(weight|is_first)\\x60 = ([0-9]+) WHERE \\x60id\\x60 IN \\(([^)]+)\\)/", $sql, $m)) throw new Exception("Unsupported source update");
    foreach ($this->rows as &$row) if (in_array($row["id"], explode(",", $m[3]))) $row[$m[1]] = (int)$m[2];
  }
}');
$oracle = new Oracle();
if (!in_array($input['prefix'] ?? '', ['', 'hot_'])) throw new Exception('Unreviewed source prefix');
$oracle->db['prefix'] = $input['prefix'] ?? '';
$oracle->prefs = ['blacklist'=>$input['blacklist'] ?? '', 'use_celsius'=>$input['celsius'] ?? false, 'per_page'=>$input['options']['perPage'] ?? 20, 'ui'=>['hot_start'=>$input['options']['offset'] ?? 0, 'hot_range'=>$input['options']['range'] ?? 7]];
$oracle->page = $input['options']['page'] ?? 1; $oracle->frozenNow = $input['now'] ?? 2000000000;
$oracle->rows = $input['rows'] ?? []; $oracle->itemRows = $input['items'] ?? [];
$_SERVER['HTTPS'] = ($input['https'] ?? false) ? 'on' : 'off';
switch ($input['op']) {
  case 'urls': $out = []; foreach ($input['urls'] as $url) $out[] = ['normalized'=>normalize_url($url), 'true'=>true_url($url), 'checksum'=>(int)checksum($url)]; break;
  case 'resolve': $out = []; foreach ($input['pairs'] as $pair) $out[] = resolve($pair[0], $pair[1]); break;
  case 'parse': $out = $oracle->parse_links($input['item'], $input['feed']); break;
  case 'weights': $oracle->weight_links(['id'=>1]); $out = $oracle->rows; break;
  case 'blacklist': $pattern = $oracle->build_blacklist_regexp(); $out = []; foreach ($input['urls'] as $url) $out[] = $pattern !== '' && (bool)preg_match('#'.$pattern.'#i', $url); break;
  case 'rank': $oracle->build_links(); $out = []; foreach ($oracle->links_by_degrees as $degrees=>$rows) foreach ($rows as $row) { $row['temperature'] = (float)str_replace(',', '', $degrees); $row['item_ids'] = array_values($row['item_ids']); $out[] = $row; } break;
  case 'temperature': $out = []; foreach ($input['scores'] as $score) { $degrees = (98.6 - 1.25) + $score; if ($input['celsius']) $degrees = ($degrees - 32)*5/9; $out[] = (float)str_replace(',', '', number_format($degrees, 1)); } break;
  case 'feed-order':
    $method = source_function($fever, 'relationships');
    $start = strpos($method, '$feed_ids_by_title = array();');
    $endMarker = '$this->feed_ids = array_merge(array(0), array_values($feed_ids_by_title));';
    $end = strpos($method, $endMarker, $start);
    if ($start === false || $end === false) throw new Exception('Source feed order fragment missing');
    $code = substr($method, $start, $end + strlen($endMarker) - $start);
    $oracle->feeds = key_remap('id', $input['feeds']); $oracle->feed_ids = array_column($input['feeds'], 'id');
    $sort = function() use ($code) { eval($code); }; $sort->call($oracle);
    $out = array_values(array_filter($oracle->feed_ids)); break;
  default: throw new Exception('Unknown oracle operation');
}
echo json_encode($out, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
`;

export function oracle<T>(op: string, input: Record<string, unknown> = {}): T {
  const key = digest([op, input]);
  if (!liveOracle) {
    const entry = loadFixture().cases[key];
    if (!entry || digest([entry.op, entry.input]) !== key) throw new Error(`No frozen PHP result for ${op} (${key}); capture this case from the original oracle explicitly.`);
    return structuredClone(entry.output) as T;
  }
  verifyOracleSource();
  const output = JSON.parse(execFileSync(phpExecutable, ["-r", phpHarness], {
    input: JSON.stringify({ root: sourceRoot, op, ...input }), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  }));
  if (capture) {
    if (!fixture) {
      const { sourceHashes, harnessSha256, phpVersion, timezone } = oracleProvenance();
      let cases: OracleFixture["cases"] = {};
      try { cases = (JSON.parse(readFileSync(fixturePath, "utf8")) as OracleFixture).cases; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      fixture = { sourceHashes, harnessSha256, phpVersion, timezone, cases };
    }
    fixture!.cases[key] = { op, input, output };
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
  }
  return output;
}

/** Actual MySQL adapter for the isolated source fixture, using source SQL. */
export function mysqlOracle<T>(op: "rank" | "weights", input: Record<string, unknown>): T {
  verifyOracleSource();
  const adapter = String.raw`
class MysqlOracle extends Oracle {
  public $pdo; public $queries = [];
  function __construct($socket) {
    if (!preg_match('#^/private/tmp/fever-migration-rehearsal-20261024-[A-Za-z0-9]+/mysql.sock$#', $socket)) throw new Exception('Unreviewed MySQL socket');
    $this->pdo = new PDO('mysql:unix_socket='.$socket.';dbname=fever_hot_parity_20261024;charset=utf8', 'root', '', [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    if ($this->pdo->query('SELECT DATABASE()')->fetchColumn() !== 'fever_hot_parity_20261024') throw new Exception('Unreviewed MySQL database');
  }
  function get_all($table, $sql) { if (!in_array($table, ['links','items'])) throw new Exception('Unreviewed source table'); return $this->query_all('SELECT * FROM '.$this->db['prefix'].$table.' WHERE '.$sql); }
  function query_all($sql) { $rows = $this->pdo->query($sql)->fetchAll(); $this->queries[] = ['sql'=>$sql,'ids'=>array_column($rows,'id')]; if (str_contains($sql, 'SUM(')) $this->scores = $rows; return $rows; }
  function query($sql) { return $this->pdo->exec($sql); }
}
`;
  const program = phpHarness.replace("$oracle = new Oracle();", `${adapter}\n$oracle = new MysqlOracle($input['socket']);`)
    .replace("case 'weights': $oracle->weight_links(['id'=>1]); $out = $oracle->rows; break;", "case 'weights': foreach ($input['feedIds'] as $feedId) $oracle->weight_links(['id'=>$feedId]); $out = $oracle->pdo->query('SELECT id,weight,is_first FROM '.$oracle->db['prefix'].'links ORDER BY id')->fetchAll(); break;")
    .replace("echo json_encode($out,", "echo json_encode(['result'=>$out, 'scores'=>$oracle->scores, 'queries'=>$oracle->queries],");
  return JSON.parse(execFileSync(phpExecutable, ["-r", program], {
    input: JSON.stringify({ root: sourceRoot, op, ...input }), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }));
}

export function legacyManifest(): Record<string, string> {
  verifyOracleSource();
  const program = String.raw`$source=file_get_contents($argv[1]); if (!preg_match('/var \$manifest\s*=\s*(array[\s\S]*?);\s*var \$vars/', $source, $m)) throw new Exception('Source manifest missing'); eval('$manifest = '.$m[1].';'); echo json_encode($manifest,JSON_THROW_ON_ERROR);`;
  return JSON.parse(execFileSync(phpExecutable, ["-r", program, sourceRoot + "fever.php"], { encoding: "utf8" }));
}


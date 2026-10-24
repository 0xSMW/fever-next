# Tests

Run commands from the repository root with the Node version in `package.json` and dependencies installed.

```sh
pnpm test
```

The default suite uses Node and project dependencies. It does not need PHP, the original Fever checkout, a running application, or a database server. Database, HTTP, browser, and historical rehearsal tests retain explicit opt-in flags and report skipped tests when those flags are absent. A default-suite pass does not establish those integration results.

## Frozen original-PHP results

`fixtures/php-oracle.json` contains 37 source-derived input/output cases used by `hot-parity.test.ts` and `collation-unit.test.ts`. All existing comparisons remain assertions: URL normalization and resolution, parsing, blacklist matching, weighting, Hot ranking and temperature rounding, and mixed numeric feed ordering through 1,100 entries. Unknown or changed oracle inputs fail until a result is captured explicitly. Results are data; the original PHP application files are not distributed here.

The corpus records source SHA-256 values, the SHA-256 of the JSON-encoded `phpHarness` string, PHP 8.5.10, and UTC. The source hashes are:

| Original file | SHA-256 |
| --- | --- |
| `util.php` | `6b9b71b06e8b021c4023fdbca1cd12ff8afc31ee6ac463aa676471e77d7b61c9` |
| `fever.php` | `f676e28ec1a4177e2877b0e6cc7427be5aec953979bbfb6ddb7fa6e0ae5d3fa0` |

The default suite validates the corpus provenance against its reviewed source hashes and current harness. It does not read the original files. To compare directly against an operator-supplied original copy:

```sh
FEVER_PHP_ORACLE=1 \
FEVER_PHP_SOURCE_ROOT=/absolute/path/to/original/app/libs \
node --conditions=react-server --import tsx --test \
  tests/hot-parity.test.ts tests/collation-unit.test.ts
```

`FEVER_PHP_SOURCE_ROOT` must be an absolute directory containing the matching `util.php` and `fever.php`. `FEVER_PHP_BIN` optionally selects the PHP executable; the default is `php` on PATH. The live lane verifies both source hashes before invoking the extracted methods and fails on missing source, changed source, unavailable PHP, or assertion differences. It does not fall back to frozen results. PHP needs `mbstring` for the PHP 8.5 `utf8_encode` compatibility shim.

For an intentional corpus update, add `FEVER_CAPTURE_PHP_ORACLE=1` to that command and use `--test-concurrency=1`. Capture writes `tests/fixtures/php-oracle.json`; run only these two suites while capturing to prevent concurrent writers. Review the resulting data and provenance changes, then rerun without capture and without the live flag. A source update also requires explicitly reviewing and updating the pinned source hashes in `hot-oracle.ts`. Capture does not derive expected values from the TypeScript implementation.

## Optional running-application checks

`pnpm test:http` requires `FEVER_HTTP_TESTS=1`, a running synthetic localhost installation, `FEVER_HTTP_BASE_URL`, `FEVER_HTTP_CREDENTIALS_FILE` with `{ "email": "...", "password": "..." }`, and `FEVER_HTTP_STORAGE_FILE` with Playwright cookies for that installation. It checks API/HTTP contracts and rejects nonlocal hosts.

`pnpm test:browser` requires `FEVER_BROWSER_TESTS=1`, a synthetic installation with the seeded item/feed identities asserted in `browser-smoke.mjs`, private `FEVER_BROWSER_CREDENTIALS_FILE` with the same credential shape, and a Playwright Chromium installation. `FEVER_BROWSER_BASE_URL` defaults to `http://localhost:3000`; it may include an application base path. Localhost, IPv4 loopback, and IPv6 loopback are accepted. For a hosted synthetic installation, explicitly set `FEVER_BROWSER_HOSTED_ORIGIN` to its exact HTTPS origin, for example `https://test-reader.example`. It must equal the origin of `FEVER_BROWSER_BASE_URL`.

Optional browser settings are `FEVER_BROWSER_CHANNEL`, `FEVER_BROWSER_HEADERS_FILE` (JSON headers), `FEVER_BROWSER_OUTPUT` (screenshots/report directory), and `FEVER_BROWSER_STORAGE_FILE` (private cookie output for HTTP tests). The default screenshot directory uses the system temporary directory. Keep credentials and cookies outside the repository.

## Guarded historical database rehearsals

These retained tests are operator drills with pinned isolated database hosts, target fingerprints, expected installation state, and synthetic fixtures. Their flags alone do not provision an environment. They intentionally reject other database targets. Review the selected test and provide the matching isolated environment before enabling it; a fresh clone cannot run these lanes without that setup. Run suites that share a database serially.

| Flag | Retained tests | Additional prerequisites |
| --- | --- | --- |
| `FEVER_INTEGRATION_TESTS=1` | `database-integration`, `database-auth-integration`, `collation-production` | Matching isolated PostgreSQL endpoint/fingerprint in those files, required schema and uninitialized installation, application auth/encryption configuration. |
| `FEVER_SCHEMA_UPGRADE_TESTS=1` | `database-schema-upgrade` | Matching PostgreSQL root/sibling databases, schema phase and retained backup artifacts; PostgreSQL 18 tools on PATH for backup/restore operations. |
| `FEVER_WORKER_REHEARSAL=1` | `worker-rehearsal-host`, `worker-rehearsal-lifecycle` | Matching worker PostgreSQL endpoint/fingerprint and Node 24; suites start controlled loopback HTTP fixtures and child workers. |
| `FEVER_WEIGHT_SQL_TESTS=1` | Live SQL case in `ingest-weights` | Matching worker PostgreSQL endpoint/fingerprint. Other assertions in this file run by default. |
| `FEVER_HOT_TESTS=1` | `hot-database`, `collation-cross-engine` | Matching Hot PostgreSQL endpoint/fingerprint; original PHP source directory, PHP with PDO MySQL, MySQL 5.7.24 isolated socket/data directory and expected collation. |
| `FEVER_PARITY_TESTS=1` | `parity-integrations` | Matching parity PostgreSQL endpoint/fingerprint and uninitialized installation; original source with `api.php`, PHP PDO SQLite, auth/encryption/setup configuration, `FEVER_BASE_URL=http://localhost:3108/fever`. |
| `FEVER_EMPTY_API_TESTS=1` | `parity-empty-fever` | Same parity environment and original-PHP prerequisites as above. |

Export the application/database configuration in the parent test process. Child Node processes use `process.execPath` and inherit this configuration; no personal Node installation or `.env.integration.local` file is required. To load a private environment file explicitly, invoke Node with `--env-file=/absolute/path/to/private.env` before the normal test flags.

`FEVER_TEST_EVIDENCE_DIR` overrides evidence output for Hot, parity, worker, and schema drills; their defaults live under `tests/.artifacts/`. The schema drill also supports `FEVER_SCHEMA_DRILL_PRIVATE_DIR` for retained private backup/manifests/inventory/secrets. Its historical default is `/private/tmp/feedafever-ops-private-20261024`, and `FEVER_SCHEMA_DRILL_PHASE` selects `all`, `upgrade`, `fresh`, `restore-v1`, or `verify`.

The worker lifecycle drill retains its narrow private lease-fixture directory `/tmp/feedafever-worker-rehearsal-20261024`, also checked by `worker-rehearsal-child.ts`. Hot retains the source socket guard `/private/tmp/fever-migration-rehearsal-20261024-<alphanumeric>/mysql.sock` and its sibling `mysql-data/` layout. These are explicit historical drill requirements, not default-suite dependencies. The target guards and private-file guards must stay aligned if an operator adapts a drill for a newly reviewed environment.

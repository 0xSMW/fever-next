# Fever compatibility and migration specification

This reference preserves the full product, data, compatibility, operational, and acceptance scope of the PHP-to-Next.js port. It includes the original 138 permanent task IDs, preference mapping, route/template/column crosswalks, keyboard rules, and Hot algorithm contract. It describes requirements and a reusable review template; unchecked boxes do not indicate that every corresponding feature is missing.

For installation use [setup](../README.md#setup), for deployment and recovery use [operations](OPERATIONS.md), and for an existing database transfer use the [migration runbook](MIGRATION_RUNBOOK.md). Source PHP is optional external audit material; neither it nor historical machine-specific test receipts are part of the standalone runtime. Keep data-bearing migration evidence, source snapshots, credentials, and account-specific deployment records private.

Read sections 1–8 for architecture and invariants, 9–11 for commands/routes/operations, 12 and 15–16 for the complete task checklist, and 17/19 for preference and source conservation mappings. Section 20 explains how to use the checklist for a specific deployment. Historical implementation debates and test-machine receipts are omitted.

## 1. Outcome, boundaries, and completion contract

Reimplement the effective Fever 1.x PHP behavior as a maintainable, self-hosted Next.js application using TypeScript and Drizzle ORM. Preserve the reader’s identity, subscriptions, group relationships, content, read and saved states, Hot behavior, external Fever API clients, desktop and mobile workflows, and operational capabilities. Make necessary security and accessibility changes explicit and reviewable. The deliverable is a working application and proven data transition, not a modern-looking reader that omits Fever’s behavior.

The source baseline is the effective Fever 1.x PHP behavior documented in the source crosswalk, including changes already disabling remote vendor authentication and updating. Original upstream documentation is supporting evidence, not permission to resurrect dead services. Do not add AI services, external content-processing services, paid infrastructure, new credentials, multiuser tenancy, recommendations, summarization, or other product expansion as part of this migration.

The optional source audit excludes secrets, source configuration files, receipts, live databases, and dependencies. Supply migration credentials explicitly through private environment files. A surface is complete only when its implementation, data handling, automated checks, accessible UI where applicable, operational documentation, and evidence are complete. A security adaptation counts only when its user-visible difference is documented and approved as part of the migration specification. A retirement counts only after explicit user approval; an unresolved or unimplemented surface remains incomplete. Stubs and disabled legacy features must be described accurately rather than counted as working features.

## 2. Evidence register and verified starting point

Source references beginning with `firewall/`, plus `boot.php`, `safety-*.php`, `README.txt`, and the legacy notices, refer to an optional external PHP source tree. They are a compatibility crosswalk, not files required in this repository. Source line numbers refer to the original audited version 139 tree; refresh them against your own source when auditing. For optional PHP differential tests, set `FEVER_PHP_ORACLE=1` and `FEVER_PHP_SOURCE_ROOT` to an absolute source root; see [testing](../tests/README.md).

| Ref | Owning source | What it establishes |
|---|---|---|
| S01 | `firewall/app/libs/fever.php:1–322` | Version 139, global/UI/mobile preferences, seven legacy tables, implicit groups/feeds, date ranges, and content modes |
| S02 | `firewall/app/libs/fever.php:803–1188` | Root query router, installation, maintenance, updater, manifest, and public Saved RSS behavior |
| S03 | `firewall/app/libs/fever.php:1189–1508`; `firewall/app/libs/api.php` | Fever API v3, authentication, query combination, IDs, paging, writes, JSON, and XML serialization |
| S04 | `firewall/app/libs/fever.php:1509–2011` | Browser auth routing, favicon/image endpoints, refresh, management actions, Feedlet, state capture, and reading-session boundary |
| S05 | `firewall/app/libs/fever.php:2012–2757` | Installation/configuration, MyISAM creation, deletion operations, disabled updater, login/password reminder, and serialized preferences |
| S06 | `firewall/app/libs/fever.php:2758–3193` | OPML, group/feed CRUD, group memberships, Sparks, feed authentication, and unsubscribe |
| S07 | `firewall/app/libs/fever.php:3194–4045` | Favicon records, refresh continuation, housekeeping, scheduling, feed ingest/update, and favicon fetch/cache |
| S08 | `firewall/app/libs/fever.php:4046–4532` | Item parsing, UID/date behavior, link extraction, repeat weights, and blacklist application |
| S09 | `firewall/app/libs/fever.php:4533–4904` | Blacklist grammar, state mutations, recently read undo, content modes, preference inheritance, CSS override, and integration links |
| S10 | `firewall/app/libs/fever.php:4905–5565` | Section membership/counts, search, exact Hot pipeline, item ordering, and changing-unread pagination |
| S11 | `firewall/app/libs/util.php:143–200,281–298,723–1110,1378–1391` | Excerpts, unsigned CRC32, frequency sorting, HTML/URL operations, normalization, and PHP/base64 serialization |
| S12 | `firewall/app/libs/request.php` | HTTP transport, redirect handling, Basic authentication use, legacy timeouts, and unsafe TLS behavior to replace |
| S13 | `firewall/app/views/default/reader.php`, `reader/*`, `ui.php`, `styles/*` | Desktop visual structure, every reader state, typography, sprite assets, Hot thermometer, and empty states |
| S14 | `firewall/app/views/default/scripts/reader.js`; `scripts/fever.js`; `keyboard-shortcuts.php` | Commands, menus, dragging, auto-read, focus/navigation, dialogs, service templates, and shortcut dispatch |
| S15 | `firewall/app/views/default/manage/*`, `blacklist.php`, `extras.php`, `feedlet/*`, `feedlet.php`, `firewall/app/data/{help,feedlet}.php` | Management forms, preferences/help, OPML options, Feedlet discovery/candidate selection, and integration instructions |
| S16 | `firewall/app/views/mobile/reader.php`, `reader/*`, `page/*`, `login.php`, `feedlet.php`, `scripts/*`, `styles/*`, `manifest.php` | Mobile screens, back behavior, previous/next article, preferences, embedded external browser, shell cache, and assets |
| S17 | `boot.php`, `safety-reboot.php`, `safety-unlace.php`, `README.txt`, `REMOTE_AUTHENTICATION_DISABLED.md`, `firewall/app/views/default/install/*` | Bootstrap/recovery, old compatibility tests, effective disabled vendor dependencies, onboarding, and licensing notices |
| S18 | Historical SQLite starter schema and routes | Optional starter import requirements and original gaps |
| S19 | Current application, configuration, and setup documentation | Maintained standalone runtime |

The original starter used SQLite and Prisma and lacked the reader domain and safe authentication. Those historical gaps explain the replacement tasks. Current code uses PostgreSQL and Drizzle; consult [package.json](../package.json) and [setup](../README.md#setup) for the supported runtime.

## 3. Architecture and decisions

### 3.1 Selected PostgreSQL deployment

**The target is Next.js + TypeScript + Drizzle ORM + PostgreSQL.** MySQL is a legacy import source only, and SQLite is an optional starter-data import source only. Neither is a target runtime backend. Keep a single production database dialect.

Use one self-hosted release with separately supervised Next.js web and refresh/maintenance worker processes, backed by a private PostgreSQL database. Use Drizzle's `pg-core` schema definitions and `drizzle-orm/node-postgres` with the `pg` driver. Pin a supported stable PostgreSQL major and compatible Node/Next/React/Drizzle versions after verifying the actual deployment host. Development, CI, staging, and production use the same PostgreSQL major, extensions, encoding, collation rules, and migrations. Do not use SQLite as a substitute for PostgreSQL integration tests.

Drizzle supports PostgreSQL through node-postgres and postgres.js; this plan selects node-postgres and bounded application pools. Use a dedicated checked-out connection for migration transactions/locks and each application transaction, with separate migration-role credentials and an explicit release migration command. Do not run automatic DDL at web startup or use production schema push. Keep reviewed SQL alongside the TypeScript schema. Pin stable compatible releases even when documentation examples show RC tags. [Drizzle PostgreSQL guide](https://orm.drizzle.team/docs/get-started-postgresql), [Drizzle migrations](https://orm.drizzle.team/docs/migrations).

Runtime `DATABASE_URL` identifies PostgreSQL. Import-only inputs use distinct `LEGACY_MYSQL_URL`, an explicit snapshot path, or SQLite `--source-path`; never infer a destructive destination from a source setting. The MySQL reader driver, if needed, belongs only to the isolated migration tooling and cannot be imported by web/worker runtime code. Schema, imports, search, Hot arithmetic, sequences, backups, and rollback must all pass the PostgreSQL-specific obligations in sections 4.1 and 16.1.

Use the supported Next.js App Router release selected by a compatibility test against Node, React, authentication, Drizzle, and the deployment target. Make the supported version an explicit ADR rather than blindly upgrading to latest. Run a Node runtime for database, crypto, XML, and worker code. A static export cannot implement this application. Do not run polling timers inside route handlers or depend on serverless request lifetime for background work. Vercel uses the authenticated finite scheduled refresh lane with durable PostgreSQL jobs; see [operations](OPERATIONS.md#vercel-scheduling).

### 3.2 Code structure and responsibilities

Application boundaries within this repository (some conceptual responsibilities share modules):

```text
app/                         Pages, layouts, route handlers, metadata, errors
components/reader/           Navigation, feed list, article stream/detail, Hot
components/manage/           Dialogs/forms, settings, OPML, Feedlet
lib/db/schema.ts             Drizzle tables, constraints, enums
lib/db/client.ts             Server-only pool/client construction
lib/domain/                  Reader queries, state commands, options, Hot
lib/ingest/                  Safe HTTP, discovery, parsing, identity, sanitizing
lib/auth/                    Credentials, sessions, guards, Fever credential
lib/compat/fever/            Root query adaptation, v3 JSON/XML wire contract
lib/validation/              Strict input schemas and DTOs
lib/jobs/                    Durable jobs, leases, retries, progress, maintenance
lib/observability/           Structured redaction, metrics, event correlation
worker/                      Refresh scheduler and bounded worker runner
scripts/                     Setup, migrations, import/export, backup/restore checks
migrations/                  Reviewed SQL and metadata
public/fever/                Preserved logo, icons, sprites, and webclip assets
tests/                       Parser, identity, Hot, API, UI, and migration checks
```

Thin routes validate, authenticate, and call domain services. Browser UI, worker, native modern API, and Fever compatibility API reuse the same item mutation and query rules. Server-only modules must not enter client bundles. Do not call the application’s own HTTP API from server components just to access the database. Avoid a generic repository abstraction that hides the Hot SQL or creates a second schema system. Use explicit functions such as `listReaderItems`, `setItemReadState`, `setSavedState`, `getHotPage`, and `applyFeedRefresh`.

Authenticated reader responses are private and uncached by shared caches by default. Explicitly handle Next.js data caching, route caching, browser history, refresh invalidation, and reverse-proxy/CDN settings. Scope every cache key to installation identity, content/state version, query, and policy version. Public Saved RSS is a separate deliberate public response. A reverse proxy supplies TLS, payload/time limits, and rate limits; Next’s [self-hosting guidance](https://nextjs.org/docs/app/guides/self-hosting) supports this architecture. Authorization is checked in the server data access boundary as well as route entry; UI hiding and proxy checks do not constitute authorization, consistent with [Next.js authentication guidance](https://nextjs.org/docs/app/guides/authentication).

### 3.3 Ownership and IDs

Preserve the single-owner installation model. Do not expose registration or accidentally turn global legacy groups into a multiuser service. The owner has a stable account row; every service establishes that installation context. If an existing starter database contains more than one owner or ambiguous nullable ownership, stop the data merge and obtain an explicit disposition rather than guessing.

Preserve every legacy feed, group, item, link, and favicon ID when importing into an empty target. Maintain integer IDs on the Fever API and keep newly allocated IDs greater than the imported maxima. JavaScript number safety must be checked for all IDs and timestamps, with exact internal numeric/string handling before any future range exceeds safe integers. Sentinel group/feed zero values are virtual scopes, not ordinary persisted rows; group `-1` means Sparks in legacy bulk read operations.

## 4. Drizzle schema and invariants

Map every source field. Adding modern fields must not overwrite the original evidence needed to reconcile migration. All foreign-key and uniqueness violations receive a report and deterministic resolution; no importer silently drops a row to satisfy a constraint.

| Table/domain | Required fields and invariants | Important indexes/constraints |
|---|---|---|
| `installation` | Stable ID, schema version, migration provenance, created/installed timestamp, canonical base URL/path, source version, initialization state | Singleton invariant; schema version gate |
| `owner` | Email, password hash, credential format/version, auth/session epoch, recovery state; never plaintext | Unique owner; unique normalized login key with explicit original-email compatibility |
| `fever_credentials` | Owner ID, hash/verifier of the accepted Fever API digest, creation/revocation time, migration source, rotation epoch | Owner + active credential; digest lookup without logging bearer material |
| `auth_recovery_tokens` | Owner ID, hashed one-time token, purpose, created/expiry/used times, revocation epoch | Unique token verifier; atomic single-use consume and expiry index; never store the raw recovery token |
| `reader_preferences` | Typed validated global settings listed below; separate version | Owner singleton; optimistic concurrency version |
| `reader_view_state` | Section, previous section, group/feed, query, focus pane, show feeds/read, Hot offset/range, last viewed, prior reading session boundary | Separate global preferences from browser-device navigation state |
| `sharing_services` | Stable ordered rows: name, original template, enabled safe template, shortcut, transport mode, compatibility status | Owner/order; shortcut conflict policy |
| `groups` | Stable legacy ID, title, excerpt/content/count/order overrides | Title collation defined; legacy duplicate-title audit before a uniqueness constraint |
| `feeds` | Stable ID, original/current URL, canonical comparison key, full title and custom-title distinction, site URL, domain, favicon ID, Spark flag, protected-feed indicator, hotlink policy, four display overrides, source timestamps | Unique accepted identity key; due-refresh, title, Spark, favicon indexes |
| `feed_groups` | Feed/group relation, preserving memberships hidden by Spark status | Composite primary key; FK to both; group membership index |
| `feed_credentials` | Encrypted username/password or Basic credential payload, key ID, updated time, auth failure status | One per feed; ciphertext never returned in feed DTOs |
| `feed_fetch_state` | Last attempted/successful refresh, last item publication/addition, status/error summary, ETag, Last-Modified, retry/due time, redirect provenance | Due time + priority; lease state separate |
| `items` | Stable ID, feed ID, raw UID and legacy truncated UID, durable identity key, title, author, raw untrusted HTML, sanitized HTML and policy version, searchable text, original link/full canonical URL, legacy URL checksum, published/added time, read time, saved boolean, updated/content hash | Unique feed+identity key after audited duplicate resolution; feed+publication+ID; read+feed+added+ID; saved+publication+ID; URL key |
| `item_identity_aliases` | Feed ID + all recognized prior UID/fallback representations -> item ID, identity version | Unique alias per feed with conflict report, never cross-feed merge |
| `link_occurrences` | Stable ID, feed/item IDs, original URL, normalized comparison string/key, legacy unsigned CRC32 fields, title and title+URL checksum, item/local/first/blacklisted flags, weight, created time, normalization/ranking version | Item FK; feed+canonical+created+ID; canonical+created; created; blacklist/first filtering; no unique URL constraint |
| `blacklist_rules` | Ordered exact-URL, domain, and imported regex rules; raw source rule, compiled status, enabled flag, version | Validated bounded matcher; explicit rejected-rule reports |
| `favicons` | Stable ID, source URL/key, MIME, safe image bytes/content hash, cached timestamp, default record behavior | URL identity and cache/content-hash indexes; preserve API representation |
| `refresh_jobs` / `job_feed_results` | Scope, requester, force mode, enqueue/due/start/finish time, progress, lease owner/expiry/fencing generation, attempts, bounded last error, cancellation | Unique active deduplication key; due/lease indexes; feed outcomes |
| `state_operations` | Operation ID, origin (UI/API), affected IDs and before/after states, timestamp, optimistic version; bounded retention | Idempotency key; operation timestamp; optional undo support |
| `migration_runs` / `migration_issues` | Source fingerprint, schema/policy versions, table counts/digests, last checkpoints, ID maps, unresolved issues, completion ledger | Unique run+source identity; resumable stage checkpoint |

Keep user reading state either on `items` for this single-owner scope or in a clearly constrained one-to-one state table. Do not introduce a many-user fanout without a separate requirement. Use `read_at = NULL` internally for unread if desired, but translate exactly to legacy zero/timestamps. Epoch seconds remain the compatibility boundary; milliseconds must never leak into the Fever API. UTC applies to storage/comparison; user-facing dates may localize. Zero/unknown source dates and pre-epoch/bad dates must have explicit conversion rules.

Global preference mapping is exhaustive: `use_celsius`, `refresh_interval`, `item_expiration`, `new_window`, `unread_counts`, `layout`, `item_excerpts`, `item_allows`, `sort_order`, `auto_spark`, `per_page`, `auto_read`, `mobile_read_on_scroll`, `mobile_read_on_back_out`, `mobile_view_in_app`, `auto_reload`, `auto_refresh`, `auto_update`, `toggle_click`, `anonymize`, `session_timeout`, `blacklist`, `share`, and `services`; nested UI mapping covers `section`, `previous`, `group_id`, `feed_id`, `search`, `has_focus`, `show_feeds`, `show_read`, `hot_start`, and `hot_range`. Preserve unknown serialized keys in a non-executable migration archive and issue report until classified.

`session_timeout` is the six-minute default boundary that distinguishes newly added items from previously unseen unread items. It is not browser authentication session expiry. New authentication timeout policy is separate. Inherit display options as global -> active custom group -> feed, with `-1` mapped to “inherit.” Group overrides apply to the relevant Kindling/group context; Saved, Sparks, Search, and Hot must not accidentally inherit an unrelated active group. Store memberships while a feed is a Spark, hide them in Kindling/custom group lists and the compatible API, and restore visibility when un-Sparking.

Long URLs, HTML, titles, and UIDs must not be truncated to the legacy 255-character limit. Preserve the legacy truncated UID alias to recognize a refreshed imported item. Canonical URL identity must retain original URLs and never use a global item-link uniqueness constraint. Two feeds legitimately contain the same article; two same-link entries in one feed may have different stable GUIDs. CRC32 is legacy metadata, not a modern uniqueness guarantee.


### 4.1 PostgreSQL conversion contract

The migration is **PHP/MySQL → Next.js/Drizzle/PostgreSQL**, plus optional preservation of the SQLite prototype. Import into a separately provisioned PostgreSQL database/schema with an explicit target fingerprint. No in-place MySQL conversion, no dual-write period, and no direct execution of MySQL SQL dumps against PostgreSQL. Decode/export to a typed neutral representation, then insert through the reviewed PostgreSQL schema in bounded transactions. Keep original source field bytes/digests where needed for comparison; malformed or unrepresentable values go to an intact restricted quarantine with an issue, never silent replacement.

| Source representation | PostgreSQL design | Required proof |
|---|---|---|
| MySQL unsigned 32-bit IDs and CRC32 | `bigint` IDs/FKs and nonnegative checked `bigint` checksum columns; bigint identity generation for new persisted entities | Values above 2,147,483,647 and through 4,294,967,295 import unchanged; virtual negative/zero scopes never become real FK rows |
| AUTO_INCREMENT with preserved IDs | `GENERATED BY DEFAULT AS IDENTITY` or equivalent reviewed sequence strategy accepting explicit import IDs | After import, next ID exceeds each nonempty table maximum; empty tables start correctly; concurrent inserts do not collide |
| tinyint flags | Boolean flags with explicit domain conversion; option enums stay constrained small integers including -1 inherit | Fever API emits 0/1 numbers, not JSON booleans or strings; null/zero distinctions preserved |
| Epoch-second timestamps | Nonnegative bigint epoch seconds for legacy content/read/fetch values, preserving zero; `timestamptz` for new job/audit/session lifetimes | No milliseconds, local timezone drift, signed-2038 overflow, or converting source zero to an accidental current date |
| TEXT/MEDIUMTEXT/varchar content | PostgreSQL `text`, bounded ingress by explicit policy, no legacy 255-character truncation for new content | Full content/URLs/UIDs survive; legacy UID aliases still match; NUL/invalid encoding is reported and preserved in quarantine |
| Config/prefs serialization | Validated scalar/array decode into typed fields and `jsonb`; original restricted migration archive retained | Key/array order where meaningful, types, unknown keys, and service order accounted for |
| Base64 favicon or encrypted feed payload | Validated `bytea` plus MIME/hash/key ID; compatibility encoder emits the legacy data string | Binary round trip and stable fallback/favicon IDs |
| utf8_unicode_ci comparisons | Explicit tested search/order/identity policies, separate canonical identity from display/search collation | Case, accents, composed/decomposed Unicode, Turkish I, ß, punctuation, and wildcard corpus compared against source |

PostgreSQL integer ranges differ from MySQL unsigned integers; signed `integer` is too small for the complete source range. Driver-returned bigint/numeric values need deliberate DTO parsing: use exact internal representations, range-check before converting compatibility IDs to JSON numbers, and never pass JavaScript BigInt directly to JSON serialization. [PostgreSQL numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html), [node-postgres type parsing](https://node-postgres.com/features/types).

Reset identity sequences only after the corresponding data import stage commits while target writes remain disabled. Use an explicit empty-table branch and verified `setval` semantics; never reset an already-advanced sequence downward on resume. Identity generation does not replace the primary-key constraint. Sequence state is not rolled back like ordinary row data, so a failed/retried stage must reconcile it; sequence gaps are acceptable, collisions are not. [PostgreSQL sequences](https://www.postgresql.org/docs/current/functions-sequence.html).

Use bounded collision-resistant digest columns for indexed identity keys, with original full URLs/UIDs stored separately and compared when a digest matches. Do not place arbitrary multi-kilobyte source values directly into unique B-tree keys. An injected digest collision must create a reconciliation issue rather than merge entities. Decode serialized PHP byte lengths before any Unicode conversion. PostgreSQL text cannot contain NUL, so preserve offending original bytes in restricted binary quarantine while deriving a separately documented safe display value. Test NUL, invalid UTF-8, multibyte serialized strings, trailing spaces, and long URLs/UIDs. [PostgreSQL character types](https://www.postgresql.org/docs/current/datatype-character.html).

Do not assume `ILIKE`, `lower()`, `citext`, or a default ICU collation reproduces MySQL `utf8_unicode_ci`. Record the selected locale/provider/version and characterize sorting, equality, and substring behavior. Prefer explicit normalized search keys when needed; preserve original text. Any `pg_trgm`/ICU extension is provisioned explicitly, tested on the target host, and used without changing substring results. Full-text search alone is not equivalent. [PostgreSQL collation support](https://www.postgresql.org/docs/current/collation.html).

Rewrite source SQL deliberately: parameterized PostgreSQL placeholders through Drizzle; `ON CONFLICT` with audited unique keys; boolean predicates; strict aggregate grouping; deterministic tie and NULL ordering; explicit numeric Hot arithmetic; and no reliance on MySQL affected-row, implicit coercion, backticks, `INSERT IGNORE`, `REPLACE`, `GROUP_CONCAT`, or permissive `GROUP BY` behavior. Hot's candidate score ordering and LIMIT occur in an inner query before the outer `score > 1.25` filter. Test final rounding against the PHP oracle rather than relying on a database cast. Ordered aggregates or application-side serialization produce stable API CSV sets. Include trailing-space and UID equality in collation fixtures, and convert aggregate counts/numeric results through the same audited DTO boundary as IDs.

Use Drizzle's PostgreSQL `.returning()` and explicit `.onConflictDoUpdate({ target: ... })` behavior where appropriate. The item conflict target is the audited feed-scoped identity key; update publisher fields only, preserving original times and reading state. Unexpected constraints must fail visibly instead of being swallowed by broad conflict-ignore logic. [Drizzle insert and upsert documentation](https://orm.drizzle.team/docs/insert).

Hot's scoring, occurrence collection, item lookup, and representative selection must see one data snapshot and one frozen clock. Use a single SQL statement or a short read-only Repeatable Read transaction; default Read Committed does not promise one snapshot across successive queries. Test a concurrent refresh/expiry during Hot retrieval to prevent mixed-generation scores or missing representatives. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

Acquire jobs atomically using short PostgreSQL transactions and row locking, such as `FOR UPDATE SKIP LOCKED`, then persist lease/fence ownership before network work. This is a queue selection mechanism, not a consistent reader snapshot. Use a checked-out connection for each transaction; never hold it across HTTP. Retry only classified transient deadlock/serialization failures with idempotency and bounded backoff. Migration advisory locks use a dedicated direct connection; document pooler session/transaction behavior instead of assuming session locks survive transaction pooling. [PostgreSQL SELECT and locking](https://www.postgresql.org/docs/current/sql-select.html).

PostgreSQL backup/restore uses tested logical archives (`pg_dump`/`pg_restore`) for portability and rehearsal, with roles, grants, extensions, sequences, secrets, and external assets covered separately. Select a production backup/PITR arrangement that meets the agreed RPO; a periodic logical dump alone may not. Verify restore client/server compatibility, restored ownership/permissions, and application schema version in an isolated destination. [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html), [PostgreSQL continuous archiving](https://www.postgresql.org/docs/current/continuous-archiving.html).

After bulk import, refresh planner statistics and measure query plans. OPS-02 and TEST-09 must verify autovacuum/analyze operation, dead-tuple growth, index/storage size, and latency across repeated content updates, link replacement, and expiry. No request-time MyISAM repair command is carried into PostgreSQL.

Rollback to PHP still requires a MySQL-compatible database and replay/export of post-cutover activity. Restoring a PostgreSQL backup cannot boot the old PHP application. Preserve the final MySQL snapshot and test the restricted reverse data mapping, unsupported new values, credential restoration, ID allocation, and mutation journal before cutover. After the rollback window, PostgreSQL is the only active datastore and the source remains an offline recovery artifact until an authorized retention action.

## 5. Existing-data migration and rollback

Two data sources require explicit handling: the legacy MySQL installation and any populated starter SQLite database. Their existence and contents are not assumed. A migration command supports offline, user-provided exports and a separately authorized read-only live extractor. It must never execute imported SQL, PHP, serialized objects, templates, or HTML as code.

The source `_config.cfg` and `_config.prefs` may contain raw PHP serialization or base64-encoded PHP serialization (S05/S11). Use a strict array/scalar parser with bounds; reject object/custom-object/reference payloads unless a safe, tested data-only decoder handles the exact case. Inspect fields by allowlist; do not include plaintext password, feed Basic credentials, activation material, or arbitrary configuration in public diagnostics.

Source table creation uses MyISAM. A `--single-transaction` dump alone does not guarantee a consistent MyISAM snapshot. Freeze all PHP web/API writes, scheduled refreshes, in-browser refreshes, and maintenance before a final export, or use a verified explicit source read lock/dump procedure. Record the freeze boundary, source table engines, source max IDs, and time. [MySQL dump consistency documentation](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html). Protect the source snapshot and secrets with restricted access and encryption; retain it for the agreed rollback window.

Migration stages:

1. Inventory source engine/version/prefix, charset/collation, row counts, primary-key maxima, total/read/unread/saved counts, membership counts, orphaned rows, collisions, UID duplicates, malformed serialization, unparseable dates, oversized content, favicon payloads, and missing feed credentials. Produce a redacted dry-run report without touching the target.
2. Generate a content-addressed migration manifest and destination schema version. Verify the target is an explicitly selected empty import destination or a previous run with the same source fingerprint. Never infer a target from ambient configuration.
3. Import owner/configuration and typed preferences. Hash the password securely in the importer; compute the legacy Fever API digest in memory from the exact legacy email/password bytes and store only its verifier. Do not normalize the credential bytes when deriving that digest. Invalidate legacy browser cookies at cutover.
4. Import groups, favicons, feeds, encrypted feed credentials, memberships, items, then link occurrences with original IDs. Preserve published/added/read times, saved state, source URLs, and per-feed options. Set sequences above maxima. Deduplicate duplicate join rows only with a logged exact count; preserve ambiguous entity duplicates for resolution.
5. Treat orphaned item/link rows as migration issues. Preserve their complete data in quarantine and obtain a reattachment, archived-source, or approved purge decision. Do not cascade them away merely to make foreign keys pass.
6. Preserve raw item HTML in restricted storage and create safe render derivatives. Preserve legacy link occurrence rows and ranking inputs before any re-extraction. Re-sanitizing is independent of ranking identity so security work cannot silently change Hot.
7. Run deterministic comparisons at a frozen clock: per-table rows and IDs, per-feed counts, group memberships, saved/read sets, complete content field digests, timestamps, preference resolution, URL identity, API pages, and Hot outputs. Recompute derived state into a separate version and compare before activating it.
8. Resume-safe batches have stable checkpoints and transaction boundaries. Test interruption after every stage and mid-batch, source-fingerprint mismatch, duplicate re-run, insufficient disk, encoding errors, and credential-key mismatch. A second run against the same completed import must not duplicate entities or reset state.
9. If starter SQLite contains user data, export it through a read-only adapter without requiring a functioning generated Prisma client. Preserve full rows before mapping, record missing legacy fields, and use an explicit ID namespace map. Never merge starter item rows by URL alone. Do not fabricate full HTML, GUIDs, saved state, or feed groups that are absent. Resolve collisions with source IDs and owner ambiguity explicitly.
10. Perform at least one full rehearsal from protected backup into an isolated environment, including rollback. Compare evidence with the manifest. No unexplained count/hash/state discrepancy is acceptable.
11. For cutover, freeze legacy writes, take final source snapshot, migrate, verify, switch the exact public base URL/path, then enable one worker. Verify browser login, Saved RSS policy, root Fever API clients, new ingestion, read/save mutations, and restore access before declaring ready.
12. Keep old PHP and its final database snapshot offline/read-only. During the rollback window, journal target feed/group/preferences and reading-state mutations. Rollback after new writes requires either a tested reverse-export/apply procedure or an explicitly accepted replay/reconciliation process; simply pointing back to the old snapshot loses user activity and is not a sufficient plan. Avoid dual active refresh writers.

Credentials and backups must be preserved until rotation/restoration has been demonstrated, then retired only by an authorized retention procedure. No tool or application should recursively remove arbitrary installation paths. Recovery commands validate nonempty existing absolute targets and move recoverable files to the applicable safe archive/Trash where appropriate.

## 6. Authentication, authorization, and API compatibility

### 6.1 Browser authentication

Retain the existing credentials-based NextAuth/Auth.js direction if a supported pinned release passes the selected Next/React matrix. Replace the Prisma credential lookup with Drizzle, use a reviewed Argon2id implementation (or a documented supported alternative), and remove every plaintext compare/storage path. A credentials/JWT strategy does not automatically need an ORM adapter; do not add a Prisma or Drizzle adapter without checking the chosen library’s credentials/session requirements.

Bind sessions to owner ID and a server-side auth epoch so logout-all, credential changes, recovery, and account changes revoke prior sessions. Use secure, HTTP-only, correctly path-scoped SameSite cookies, TLS, a secret independent of the owner password, bounded session lifetime, login throttling, safe redirect validation, generic failure messages, and CSRF/origin checks. Re-check authorization in all read and write services; protect `/feeds`, items, media, jobs, settings, import/export, and every administrative action. Public exceptions are only setup before initialization under an installation token, static safe assets, deliberate Saved RSS, login/recovery entry, and the Fever API’s own authentication envelope.

Replace “email me my password” with a one-time reset flow. Default self-hosted recovery can be a local operator CLI/token shown once with a short lifetime, avoiding an unconfigured mail dependency. Optional email delivery is a separately verified project service and must obey user email tooling/authorization rules; never log, display in preferences, or transmit the existing password. Password fields are empty when editing credentials. Existing legacy password whitespace/email-byte behavior is characterized for migration; do not trim new passwords or silently normalize an existing password.

Separate new user-visible “mark most recently read unread” from a reliable operation-based undo internally. Preserve the compatible legacy operation until its anomaly is explicitly approved for correction: outside Sparks, legacy chooses the latest read timestamp excluding Sparks, then updates *all* items newer than that timestamp minus 15 seconds. This unscoped update can include Sparks. Capture a regression fixture and list the proposed precise scoped undo as an approved adaptation rather than pretending they are identical.

### 6.2 Root URL and Fever v3 contract

Serve existing installation URLs such as `https://host/base/?api`, `?api=json`, and `?api=xml`, including combinations of query flags and form-encoded POST bodies. A compatibility rewrite must route query `api` to an internal Node route such as `/api/fever` without a redirect, preserving method, body, query, and base path. Do not put a `route.ts` and `page.tsx` at the same App Router segment; verify the selected framework’s proxy/rewrite mechanism and the reverse proxy together. Merely adding `/api/fever` breaks existing clients.

Authenticate `api_key` as the lowercased submitted hexadecimal MD5 digest of exact `email:password` legacy bytes, as source does, while comparing a server-side verifier in constant time. This digest is a bearer credential, not a password hash. Import its verifier without retaining the plaintext password. Support deliberate rotation, including recomputing a new digest while the user supplies a new password, with clear client reauthentication behavior; do not promise both permanent old-client compatibility and automatic rotation. If multiple separately revocable API credentials are later added, retain the standard single-digest path for existing clients.

| API surface | Required behavior |
|---|---|
| Every request | `api_version: 3`, `auth: 0/1`; failed auth performs no data query/mutation; characterize response status/content type; authenticated `last_refreshed_on_time` including zero/empty case |
| `groups` | Integer group IDs/titles and `feeds_groups`; exclude virtual groups from stored group output |
| `feeds` | IDs, favicon fallback ID 1, title fallback, URL/site URL, Spark integer flag, last updated epoch; relationship rows contain comma-separated `feed_ids`; exclude Spark affiliations without deleting memberships |
| `favicons` | Stable IDs and legacy `mime;base64,...` data strings, including default fallback |
| `items` | `total_items`, max 50 objects; complete field names/types: ID, feed ID, title, author, `html`, URL, saved/read integers, created epoch |
| Selection precedence | Union `feed_ids` with feeds from `group_ids`; then `max_id` takes precedence over `with_ids`, which takes precedence over `since_id`; exact strict `<`/`>` boundaries; no duplicates/skips |
| Paging | `max_id=0` descends from most recent ID; default/`since_id=0` ascends; `with_ids` capped at 50; characterize unspecified original ordering and choose documented deterministic tie order |
| `links` | `offset`, `range`, `page`; exact Hot phases, integer IDs, float temperature, item/local/saved flags, source item-ID CSV, `use_celsius` integer |
| `unread_item_ids`, `saved_item_ids` | Complete comma-separated sets, including empty-string behavior; no replacement with UI pagination |
| POST `mark`, `as`, `id`, `before` | Explicit supported-command allowlist, no dynamic method invocation; item read/unread/saved/unsaved; feed/group read; feed spark/unspark as source supports; automatically return the corresponding unread/saved ID set |
| Bulk-read bounds | Preserve `added_on_time < before`, group 0 across all feeds, group -1 Sparks, real group membership semantics; integer seconds; fixture the missing/zero/invalid boundary behavior before adopting validation differences |
| `unread_recently_read` | Characterize source 15-second rule and global update anomaly; approved correction only |
| Generic link saved/unsaved | Source methods are empty stubs. Preserve documented no-op compatibility unless user explicitly approves creating a new externally saved-link capability. Actual UI saving of local Hot entries targets the backing item and marks it read |
| Formats/combinations | JSON and XML may combine multiple requested sections; preserve field presence, numeric/string/null distinctions, CSV strings, empty collections, XML singular-container conventions, and UTF-8/CDATA escaping |

Use a standards-safe JSON/XML serializer with golden contract fixtures. Do not reproduce invalid XML, XSS, SQL interpolation, unlimited body sizes, or dynamic method dispatch to get byte equality. Document any safety-driven wire difference and test an actual user-selected Fever client. New malformed-input behavior must be predictable; modern endpoints can use strict 4xx responses, while compatibility endpoints preserve valid-client responses and record differences.

The API historically returns raw item HTML. Preserve source HTML in export/storage, but decide whether compatible API `html` returns raw untrusted content or the safe derivative. Recommended: safe HTML with equivalent readable content, and fixture expected sanitization differences. A transport labeled legacy compatibility is not permission to leak active scripts. Do not claim exact content bytes if sanitization changes them.

## 7. Ingestion, item identity, fetching, and content safety

Use an explicitly bounded safe-fetch module for feeds, feed discovery, redirect following, favicon discovery/downloads, image proxying, and any later user-triggered service callback. Feed parser convenience `parseURL` must not bypass this transport.

Allow only approved HTTP(S) URLs. Validate URL credentials, host, port, and normalized form; disallow arbitrary schemes, loopback, private/link-local/multicast/reserved addresses, cloud metadata, IPv4-mapped IPv6, and alternate numeric encodings by default. Resolve every redirect and DNS answer, pin connections to validated addresses where the HTTP library permits, and defend against DNS rebinding. Cap redirects and enforce total deadline, connect/read timeout, byte limits, compressed/decompressed limits, content type, and XML depth/entity limits. TLS verification stays on. Strip Authorization and cookies when crossing origins; no credential forwarding merely because a redirect asks for it. An explicitly approved private-feed allowlist may be configured per origin without disabling all protections. Fetching failure cannot remove existing items or credentials.

Use conditional GET with ETag/Last-Modified, 304 handling, reasonable jitter, per-host concurrency/rate limits, Retry-After, bounded backoff, and user-visible errors. Persist attempt and success separately. A 401 marks a feed as needing credentials; keep previously entered encrypted credentials recoverable until the user replaces/removes them, and never echo Basic strings. 404/410, invalid XML, TLS errors, timeouts, and oversized feeds have distinct statuses. Avoid silently unsubscribing dead feeds.

Refresh all, group, and feed scopes use durable jobs with deduplication, per-feed leases, fenced completion, cancellation between safe boundaries, restart recovery, and progress visible to web/mobile. Never keep a DB transaction open during HTTP. Fetch/parse outside the transaction; atomically merge item updates and link changes under the lease generation. Preserve Kindling-before-Sparks and oldest-due priority, a 15-minute default interval, force refresh behavior, protected-feed prompts, and favicon refresh. Browser auto-refresh becomes authenticated enqueueing and progress polling/SSE; cron becomes a local command or authenticated scheduler endpoint. Anonymous `?refresh` is adapted to a documented safe operation and must not remain a public workload trigger.

Parse RSS 2.0, Atom, and legacy supported namespace/date/content variants. Build fixtures from parser source behavior before choosing whether `rss-parser` suffices. Cover full `content:encoded`/Atom HTML, description/summary precedence, `feedburner:origlink`, alternate links, authors and Dublin Core/iTunes/media-credit fields, `xml:base`, relative URLs, CDATA, malformed-but-recoverable XML, declared encoding, empty titles, GUID `isPermaLink=false`, no date, future dates, and multiple date fields. Preserve source semantics where they are observable: infer date from URL if source did; cap future publication to first observation; use first-seen time once for undated items; never advance publication/added time on repeated refresh; do not reset read/saved state during content updates.

Identity order is feed-scoped stable GUID/Atom ID, then compatible legacy URL-derived alias, then a deterministic documented fallback for missing GUID and unusable/missing link. The fallback must not be `''` or a changing timestamp. Preserve legacy truncated UID aliases for imported feeds, while storing full new IDs. A content/title-based fallback has explicit limitations when publishers edit undated, linkless entries; retain raw source fingerprints and avoid unreviewed merges. Detect publisher GUID reuse, URL changes, duplicate UIDs within a response, and canonicalization collisions; decide deterministic update versus quarantine with evidence. Re-running a refresh after a crash must be idempotent.

Store full source HTML separately from safe render HTML. Parse and sanitize on the server with a vetted library and versioned policy; reject scripts, event attributes, unsafe URLs, active SVG, forms, plugins, unsafe iframes, CSS injection, and base/meta/navigation tricks. Resolve relative media/link URLs with validated bases. Sanitize titles/authors/metadata too. Search highlighting operates on text nodes after sanitization. Maintain text-only, text-with-images, and rich-content choices, but legacy “unfiltered” becomes safe rich content or an explicitly isolated restricted document; never inject unfiltered publisher HTML into the application origin. Keep long code blocks, tables, figures, lists, and valid Unicode readable.

A protected/signed media endpoint refers only to media already associated with an authorized item/feed; it is not an arbitrary `?img=URL` open proxy. Apply safe fetch, raster validation/re-encoding where needed, MIME sniffing, size caps, private cache policy for protected feeds, and content security policy. Offer meaningful image errors and preserve hotlink-prevention intent. Favicon fetching uses page discovery plus `/favicon.ico` fallback, safe content handling, fallback icon, recache, deduplication, and stable compatibility IDs. Imported favicon data is untrusted and validated. Do not use arbitrary `next/image` remote allowlists as a substitute for SSRF controls.

Expiration retains saved items indefinitely unless a separately confirmed unsubscribe/maintenance operation deletes them. Unsaved expiration is 2/4/6/10 weeks by source preference and based on source publication time; links expire separately even if their parent item is saved, matching source behavior unless an approved adaptation changes it. Newly fetched items older than retention are skipped as source does. Reweight surviving occurrences after expiration. Freeze retention during migration/rehearsal and first validation so a cleanup job cannot erase the evidence being compared.

## 8. Hot: exact source algorithm, including phase order

Hot is a compatibility-critical product feature. Implement it as a versioned pure domain pipeline with immutable input fixtures and a frozen clock, backed by explicit indexed SQL where helpful. Do not substitute counts, likes, generic decay, all-occurrence sums, a universal time-decay score, or an external recommendation service.

1. **Comparable URL.** Follow `true_url` for the source’s Bird Feeder `seed` and `/rd?rd=` or `/rd?url=` wrappers. `normalize_url` strips HTTP/HTTPS/feed scheme and generic `www`, lowercases host as implemented, removes `/index.<extension>`, removes slash before `?`, and removes final slash. It intentionally retains fragments. It is a comparison key, not the URL to navigate. Preserve its source quirks in a versioned compatibility implementation and fixture each transform. Do not silently add tracking-parameter removal, fragment removal, host merging, or live redirect resolution.
2. **Occurrences.** Every item contributes its own nonempty link (`is_item=1`), plus eligible nonempty-title anchor links in its description. Resolve links, compute localness from source feed domain, skip source’s login/share/mail/anchor/empty-link patterns, and retain duplicate occurrences. Store source title, URL, checksum, title+URL checksum, timestamp, and blacklist result. Port the ignore list as explicit compatibility data. Safe parser changes must be compared against legacy extraction.
3. **Per-feed repeated-link weights.** Across retained occurrences of a feed, order by created time ascending. The first occurrence per canonical URL gets `is_first=1` and weight 0, except a local non-item link or `https?://feeds.feedburner.com...` starts at weight 1. Each repeat gets prior weight + 1 and `is_first=0`. Reweight after insertion, replacement, and expiry. Original equal-time ordering is underspecified; record fixture order and choose ID as a deterministic tie rule with explicit compatibility notation.
4. **Time window.** `start = frozenNow - offset*86400`, `end = start - range*86400`. Require created time strictly greater than end. Add strict `< start` only when offset is nonzero; the now window has no upper-bound predicate in source. Current ingest clamps future dates, but imported anomalies remain test cases. Source UI offsets are 0–7, 14, 21, 28, and 35 days; range is 1–7, 14, 21, 28, and 31 days. API values need bounded validation compatible with valid clients.
5. **Candidate scoring.** Filter `is_blacklisted=0`, `is_first=1`, and the time window. Group by comparable URL/checksum and sum `1.25 / 2^weight`. Sort score descending. Apply page limit/offset using `per_page` (default 20) **before** filtering to score `>1.25`. This ordering must remain visible in fixtures; moving the threshold before pagination is a behavior change.
6. **Source collection.** For surviving candidates, collect all nonblacklisted in-window occurrences, including repeats, ordered created descending and item flag descending. Also collect local item/original occurrences for those URLs without the time-window predicate, merge, and deduplicate by occurrence ID. This source’s second query does not use the first query’s blacklist predicate; preserve a characterized expectation or document the safety/correctness adjustment explicitly.
7. **Representative selection.** Prefer item occurrence over non-item; then local over nonlocal when itemness ties; then older created time when both flags tie. Do not use most recent by default.
8. **Title/description.** An item representative uses its item title and saved state, with description only when local, and source permalink-tail cleanup. For a non-item representative: prefer repeated eligible anchor title; otherwise repeated source item title; otherwise highest count of normalized title words appearing in URL, first anchor titles then item titles; otherwise source item title fallback. Characterize equal-frequency order and empty/no-word titles. The source’s alternative-description fallback is commented out, so do not activate it as parity.
9. **Temperature.** Fahrenheit = `(98.6 - 1.25) + score`; Celsius = `(F - 32) * 5 / 9`. Format to one decimal with PHP-compatible rounding behavior; group by formatted temperature. API returns numeric temperature. Test rounding ties explicitly. Within equal formatted temperature, local item representatives come before other links; retain established score order and a documented deterministic tie rule.
10. **Contributing items.** Build unique source item IDs and remove those outside the start/end bounds for presentation, while an older original may still supply representative title/content. Preserve source read states, source feed labels/favicons, source navigation, and save action only for real backing items. Verify UI and API use the same pipeline.

Preserve imported unsigned CRC32 values for audit/API migration evidence but use collision-resistant canonical identity for new integrity constraints. Before changing grouping from CRC32 to a full key, prove no legacy collision exists in the imported dataset or obtain a recorded collision-resolution decision. A collision must never silently combine unrelated articles or disappear from verification.

Golden cases must include one citation (not Hot), two independent feeds, one feed repeating a link, local non-item penalty, FeedBurner penalty, Spark contribution, groups not filtering Hot, exact boundary timestamps, expired first occurrence, updated-item link replacement, blacklisted URLs/domains/regex, out-of-window original, duplicate source IDs, local versus nonlocal selection, inferred titles, empty titles, Fahrenheit/Celsius, equal weights/rounded ties, and multi-page threshold behavior. Store candidate score and representative/source evidence as well as final render output so a visual match cannot hide an incorrect algorithm.

## 9. Reader, management, and visual specification

Preserve Fever’s logo, degree mark, red/gray palette, thermometer/temperature hierarchy, Hot/Kindling/Saved/Sparks names, feed favicons, recognizable card/list structure, and supplied normal/retina assets. The source uses Helvetica/Arial, red `#A10`, gray panels, source lists, and distinct read/unread/new/saved states; the new create-next-app branding and Geist dependency are not a visual baseline. Inventory file hashes, dimensions, licenses/notices, and use of each source asset. Reuse supplied assets or faithful CSS equivalents; do not generate replacement artwork or introduce a wholesale design system. Check original EULA/distribution restrictions before redistributing assets or a public package. A private migration does not settle redistribution rights.

One shared responsive application supports desktop’s groups/feed/content panes and mobile’s group → feed → item list → article drill-down. Use responsive layout and device capabilities instead of legacy user-agent gates, fixed 320/480-pixel widths, or Chrome Frame. A user can still select a compact/mobile layout where `?mobile` was useful. Browser Back/Forward, deep links, refresh, scroll restoration, pane selection, search clearing, and return from Feedlet must work coherently.

| Feature | Required acceptance behavior |
|---|---|
| Hot | Temperature groups, range/start menus, source list, original item content, save/read actions, blacklist action, next page, empty guidance, and F/C choice |
| Kindling | All non-Spark feeds, virtual All items/unread row, custom groups, correct counts, alphabetical group/feed list, feed title fallback, hidden-read behavior, alphabet jump strip or equally efficient accessible jump control |
| Saved | All saved items, including saved Spark items, all/individual feed filters, count, sort, excerpt/full content, saved state across refresh and retention |
| Sparks | Separate feed membership, no Kindling/custom group unread contribution, Hot contribution, bulk edit, promote/demote, bulk unsubscribe, and preserved hidden group memberships |
| Search | Substring search across feed title/URL/site URL and item title/link/description as source, matching feed list/counts, all/feed scope, empty/no-result states, highlighting, prior-section return; include read and Spark data as legacy does |
| Article states | New versus unread using reading-session boundary, read, saved, excerpt/full, focused, source feed/author/date, broken image, content empty, protected feed, long content, and later updated content |
| Reading actions | Open marks appropriate item read; save UI marks backing item read as source; explicit read/unread; bulk current feed/group/all at a render-time cutoff; recently read undo; counts reconcile after optimistic mutations and failures |
| Paging | Stable modern cursors or retained IDs for changing unread lists; no skipped items when auto-read shrinks the result; pagination when all/read/saved/search and arrival of new items; scroll position stays stable during refresh |
| Feed management | Add/edit/delete, feed URL and optional custom title, site URL resolution, group multi-select, Spark flag, content/display overrides, hotlink policy, optional credentials, credential prompt, refresh and favicon recache, visit site, visit-and-mark-read |
| Group management | Add/edit/delete, feed multi-select, four display overrides, all-group handling, add/remove membership with duplicate prevention, drag-and-drop plus accessible menu/keyboard alternative |
| Destructive group deletion | Without unsubscribe, remove group and membership only; with unsubscribe, preview affected feeds, including their other memberships and saved items; preserve source Spark exception unless explicitly adapted |
| Preferences | Behavior, Display, Refreshing, Sharing, and Login tabs plus mobile settings; every field from schema mapping either works or has an approved adaptation/retirement explanation |
| Dialogs/menus/help | Feed/group/Sparks add/edit/delete, credential, blacklist, import/export, preferences, updates/about, tooltips/help, errors, confirmations; focus trap, escape, return focus, labeled controls, correct default action, inline validation, pending/error states |
| Mobile | Group/feed/article drill-down, previous/next, back labels, options, read-on-scroll, read-on-back-out scoped to rendered rows and their captured cutoff, refresh state, external navigation choice, search, saved toggle, logout, portrait/landscape/tablet |
| External links | `new_window`, referrer anonymity, safe `noopener`, open-original and feed-site visit; never route navigation through unvalidated redirects |
| Sharing | Ordered custom services, title/URL/excerpt substitutions, single-character shortcuts, add/remove, mailto, web share destinations, and documented safe handling of `#` background mode |
| Saved RSS | Opt-in 30 most recent saved by source publication time, RSS field/GUID compatibility, login-page discovery when deliberately public, XML escaping, canonical base URL, protected-feed publication decision |
| Feedlet | Bookmarklet or modern equivalent, server-discovered and supplied feed candidates, XML/feed page detection, alternate RSS/Atom versions, guessed anchor candidates marked as guesses, already-subscribed detection, select all, per-feed group/Spark/display/auth options, confirmation, cancel, and safe return URL |
| Integrations | Subscription URL entry, base-path hosting, login continuation, Help/Extras, shortcuts, local changelog, installation/onboarding, and authorized scheduled refresh instructions |
| CSS overrides | Discover `override.css` / `override-mobile.css` if present under authorized paths; preserve customization through documented local theme/override hooks after review; do not execute imported scripts or assume fixed source DOM selectors remain valid |

Search may use indexes to optimize the source substring result, but a full-text-only implementation changes semantics. Preserve phrase/substrings, punctuation, URL, case, Unicode, and wildcard behavior deliberately. SQL wildcard characters `%` and `_` need fixtures and an explicit product decision: literal-search UX is safer and more predictable, but silently escaping them changes legacy matching. Parameterization prevents SQL injection independently of that choice. Any FTS enhancement is additive and separately labeled.

Use semantic landmarks, buttons, links, forms, headings, and lists. Unread/saved/focus must not rely only on color or hover. Meet WCAG 2.2 AA for supported surfaces with keyboard, screen-reader, zoom, contrast, touch targets, and reduced-motion tests. Preserve visual character while allowing readable text scaling. External article content gets a constrained typography container; malicious and very wide content must not damage the surrounding application. Avoid endless animation, focus theft, reading fetch-only/preloaded content, or moving the focused item on refresh.

Keyboard support must include `1–5`, `Z`, `A`, `Shift+A`, `R`, `Shift+R`, `S`, `N`, `Shift+N`, `U`, `F`, `P`, Space/Shift+Space, `J/K`, Enter/`0`, `B`/`Shift+B`, `O`, `V`/`Shift+V`, `I`, Escape, `/`, pane arrows, group/feed up/down, and Shift+up/down source navigation. Also characterize actual source dispatch differences: `H/L` aliases, numpad zero, modifier-period dialog dismissal, Enter form submit, and service-shortcut priority/conflicts. Do not intercept typing in inputs, textareas, selects, contenteditable, IME composition, or platform/browser shortcuts. Keyboard help is generated from the command registry so behavior and documentation cannot drift. When a custom service key collides with a core command, preserve the existing configuration and present an explicit conflict resolution rather than silently changing one.

## 10. Preserve/adapt/retire disposition ledger

`P` = preserve observable capability. `A` = preserve purpose with a specified modern/security/accessibility adaptation. `R?` = proposed retirement of a mechanism or disabled surface, requiring explicit approval before removal. An approved safe replacement may satisfy the purpose without executing unsafe source behavior. A pending decision cannot be marked done.

| Legacy route/surface | Disposition and target | Trace tasks |
|---|---|---|
| `route_installation`, install templates | A: token-gated local bootstrap, supported-runtime/database checks, owner creation, preferences, OPML onboarding; connection secrets remain server/operator configured | FND-03, AUTH-05, OPS-01 |
| `route_uninstall`, `uninstall.php` | A: authenticated export/backup and explicit scoped data removal workflow; operator removes deployment; no web-process self-delete | OPS-06 |
| `route_empty`, `empty.php` | A: preview then confirmed removal of all subscriptions/groups/items/links/favicons while retaining owner/preferences and a default icon | OPS-06 |
| `route_unorphan`, `unorphan.php` | A: integrity report and recoverable quarantine first, confirmed cleanup only for selected orphan data | MIG-04, OPS-06 |
| `route_flush`, `flush.php` | A: confirmed purge of unsaved items/links/cache and reset fetch metadata while keeping subscriptions/groups/options/saved content; preserve titles without source’s `[SURVIVED FLUSH]` corruption as an explicit correction | OPS-06 |
| `route_updates` / `manage/update` | A: local release/version status and operator upgrade guidance; source remote check is already disabled | OPS-04 |
| `route_revert` | A: tested previous-release and database restore procedure; R? old same-version vendor re-download mechanism | OPS-04, OPS-05 |
| `route_update` | A: immutable release + reviewed migration rollout; R? writable webroot automatic updater | OPS-04 |
| `route_updated`, `updated.php` | P/A: post-upgrade local release note/acknowledgment, with no vendor dependency | OPS-04, DOC-01 |
| `route_manifest`, mobile AppCache | A: modern install metadata/static-shell caching if useful; R? broken obsolete AppCache mechanism. No claim of legacy full offline article support | UI-07, OPS-01 |
| `route_rss`, default RSS | P/A: explicit public Saved RSS, 30-item limit, discoverability, and privacy decisions | INT-03 |
| `route_api` | P/A: exact valid Fever v3 contract/root URL with typed validation, safe serializers, secure digest verifier | API-01–API-06 |
| `route_auth`, default/mobile login | A: secure credential/session handling, login continuation, logout, recovery replacing plaintext reminder | AUTH-01–AUTH-05 |
| `route_favicons` | P/A: stable icons + compatible API data, HTTP cache validators; generated CSS endpoint may map to a safe compatibility response | ING-06 |
| `route_image` | A: item-associated authenticated media proxy, no unrestricted URL proxy | ING-07 |
| `route_refresh` | A: durable jobs/worker, scoped manual refresh, status/cancel, authenticated cron; R? anonymous workload trigger/iframe execution transport | JOB-01–JOB-04 |
| `route_manage` | P/A: all 20 actions below, typed commands, protected mutations, accessible dialogs | DOM-01–DOM-06, UI-05, INT-01–INT-02 |
| `route_blacklist`, blacklist page | P/A: exact URL/domain/imported regex behavior, bounded safe matcher and recompute job | HOT-04, UI-05 |
| `route_subscribe` | A: preserve integration URL as prefilled confirmation followed by protected POST, never mutate merely by loading GET | INT-02 |
| `route_feedlet`, default/mobile/bookmarklet/login | P/A: all discovery/candidate/option/login/return functions with safe navigation fallback for CSP-blocked injection | INT-02 |
| `route_extras`, Extras/help/data | P/A: current Feedlet and cron setup, referrer/privacy explanation, no `curl -k` advice | DOC-01, INT-02, JOB-04 |
| `route_shortcuts`, keyboard page | P/A: accurate commands plus accessible controls | UI-06 |
| `route_reader`, default/mobile reader families | P/A: complete responsive reader with shared state and deterministic navigation | DOM-01–DOM-06, UI-01–UI-08 |
| Dispatcher `empty-cache` | A: protected confirmed recache operation, stable fallback/favicon behavior | ING-06, OPS-06 |
| Dispatcher `visit` | P/A: safe feed-site navigation with supported read action separation | UI-04 |
| `boot.php`, old compatibility checks | A: deployment preflight replaces PHP/MySQL-extension/writable-webroot/browser checks; R? old executable bootstrap | OPS-01 |
| `safety-reboot.php`, `safety-unlace.php` | A: operator recovery/uninstall runbooks; R? rename-to-run remote scripts and recursive deletion paths | OPS-05–OPS-06 |
| Vendor activation/license gateway | R?: already bypassed/disabled in this repository; do not restore calls or describe remote activation as working; retain appropriate legal notices independently | FND-03, DOC-01 |
| Raw password reminder | A: one-time recovery. Raw password disclosure never ported | AUTH-04 |
| Unfiltered publisher HTML | A: safe rich mode, with archived source and documented render differences | ING-05 |
| `javascript:` service URLs | A/R?: preserve original config in migration report; replace only with safe destination explicitly selected by user, otherwise visibly disabled with explanation | INT-04 |
| `#` background service URLs | A: explicit user-triggered, validated destination with visible success/failure; no invisible arbitrary cross-origin transmission on load | INT-04 |
| Mobile embedded “Elsewhere” iframe | A: optional constrained embed when site permits, external-browser fallback and clear failure; never bypass CSP/frame restrictions | UI-07 |
| Theme overrides and sprite imagery | P/A: preserve identity and user theme intent; document selector/hook changes | UI-01, DOC-01 |
| MyISAM optimize/repair and source `update()` migrations | A: Drizzle versioned migration/health checks, PostgreSQL vacuum/analyze and operational maintenance, schema lock; R? automatic request-time repair/DDL | DB-02, OPS-02, OPS-04 |
| Debug/error flags and HTML/XHR script fragments | A: private diagnostics and structured client data; R? exposed credentials/SQL and executable response-fragment transport | FND-04, OPS-02 |

The 20 management actions are individually represented: `save-preferences` -> DOM-06; `import` -> INT-01; `export` -> INT-01; `auth` -> ING-02; `add-group`/`edit-group`/`delete-group` -> DOM-02; `add-feed`/`edit-feed`/`delete-feed` -> DOM-01; `add-to-blacklist` -> HOT-04; `add-feeds` -> INT-02; `edit-sparks`/`delete-sparks` -> DOM-03; `clear-search` -> DOM-05; `statuses` -> DOM-04/API-04; `add-feed-to-group`/`remove-feed-from-group` -> DOM-02; `unread-read` -> DOM-04; `item` -> ING-05/UI-04. No dynamic view path or arbitrary posted field should survive into the new implementation.

## 11. Operations, deployment, and documentation

The baseline deployment is a reproducible Node application/worker release, a TLS reverse proxy, a private PostgreSQL service, and durable backup/media storage. Verify the actual intended host, base path, DNS/TLS arrangement, database ownership, scheduler, storage, and resource limits before writing deployment configuration. If AWS is selected, use `us-west-2` unless the user specifies another region. No hosting account is implied by the existing Next template’s Vercel link.

Build once, record source revision/artifact digest/dependency lock/schema version, promote the identical artifact, and apply SQL migrations once under an explicit lock. Runtime credentials lack DDL privileges; migration credentials are scoped and short-lived operational inputs. Encrypt feed credentials with a separately backed-up key and key IDs; rotation must preserve old decryptability until rewritten and verified. Pin packages and runtime, use a lockfile, review advisories, and document minimum supported browser/runtime/database versions. Disable legacy PHP routing at the public origin after cutover while retaining its rollback artifact offline.

Back up database content, migration metadata, required assets/media, owner/API verifiers, and encrypted feed credentials together with a securely separate recoverable encryption-key procedure. OPML alone is not a backup: it does not preserve items, state, Hot, credentials, or preferences. Establish backup frequency, retention, RPO, and RTO with the actual host; proposed minimum gate is one demonstrated full restore and a measured final cutover rehearsal, with no unapproved loss window. Test database-consistent backups, checksums, restore into an isolated environment, and alerting when backups age or fail.

Readiness tests the expected schema and database access; liveness must not fail simply because one feed host is unavailable. Worker health includes lease freshness, queue age, last completed refresh, and run errors. Structured logs correlate request/job/feed/migration IDs and redact passwords, API keys, cookies, Basic headers, private feed URL query secrets, and raw article content by default. Track refresh outcomes, fetch latency/status, parse failures, retry backlog, ingestion counts, identity conflicts, job duration, DB pool/slow queries, API failures, server errors, backup age, and maintenance removals. Provide an owner-readable diagnostics page with safe per-feed status, retry actions, and exportable redacted evidence.

Resource limits are part of correctness: maximum request/import/feed/media sizes, item/link counts per response, parallel fetches, per-host fetches, queue size, total work per job, log retention, and timeouts must be configurable and tested. The source ingests at most 100 entries per feed response; preserve the default cap initially, report truncation, and require an explicit approved behavior change before raising it. Avoid losing items simply because a feed puts newest entries after the cap; fixture this legacy limitation and offer a deliberate operator setting if approved.

Provide runbooks for fresh install, legacy migration, optional starter-data migration, adding credentials, root/base-path URL setup, scheduled refresh, backup/restore, recovery, upgrades, schema failure, interrupted jobs, stalled feeds, media failures, privacy settings, disabling Saved RSS, export, uninstall, and rollback after target writes. Replace all Prisma setup instructions, invalid `next lint` assumptions, and obsolete Node requirements only after the chosen toolchain is verified. Preserve source copyright/licensing notices and do not claim redistribution rights.

## 12. Executable migration checklist

Task IDs are permanent. Complete a task only by attaching its required evidence to the evidence manifest and linking its tests. Do not replace an unchecked task with prose claiming completion. Dependencies are phase gates below plus any task called out. Evidence IDs name the expected artifact/test family; they are not claims that files currently exist.

Use each task’s explicit `Depends` list as the completion dependency graph. Contract definition and fixture authoring may start earlier; a dependent task cannot be checked before its prerequisites pass. Phase order is foundation, PostgreSQL/Drizzle, domain and migration tooling, API/UI/integrations, acceptance, and cutover. DB-05 intentionally runs after preservation and replacement work. Independent branches may proceed concurrently once their contracts are agreed.

### Foundation and scope

- [ ] **FND-01 — Enumerate the complete source.** Inventory routes, management actions, templates, JavaScript commands, preference keys, parser utilities, assets, and boot/recovery behavior against the chosen source. Acceptance: every inventory row has a disposition, owner, task, and test. Evidence: `E-FND-01` source inventory with hashes and scope report. Depends: none.
- [ ] **FND-02 — Record the starter gap audit.** When importing starter data, map schema/call-site mismatch, authorization, credentials, identity, content, membership, state, scheduling, and UI gaps to replacement tasks. Acceptance: no feature credited solely for scaffolding. Evidence: `E-FND-02` starter audit and replacement mappings. Depends: FND-01.
- [ ] **FND-03 — Resolve architecture and policy ADRs.** Record the selected PostgreSQL target and pin runtime/database/auth versions, host/base path, single-owner model, approved safe adaptations/retirements, and licensing/distribution scope. Acceptance: no production-blocking choice is implicit; vendor calls remain disabled. Evidence: `E-FND-03` accepted ADR/disposition ledger. Depends: FND-01, FND-02.
- [ ] **FND-04 — Establish project boundaries and validation.** Add server-only boundaries, typed input/DTO errors, redaction, reproducible scripts, unit/integration/browser test harnesses, and a migration ledger. Acceptance: invalid inputs cannot mass-assign schema fields or load arbitrary views, and secret fixtures never appear in output. Evidence: `E-FND-04` harness and boundary test report. Depends: FND-03.

### Database and Prisma replacement

- [ ] **DB-01 — Implement complete PostgreSQL Drizzle schema.** Use pg-core and represent every mapping in section 4, including many-to-many groups, timestamps, saved state, link occurrences, preferences, credentials, and jobs. Acceptance: FK/uniqueness rules preserve legitimate same-link items and imported IDs; schema diff covers every legacy field. Evidence: `E-DB-01` mapping review and constraint tests. Depends: PG-01, FND-04.
- [ ] **DB-02 — Implement versioned SQL migrations.** Generate/review SQL, baseline empty-target initialization, migration lock, version gates, and dedicated connection. Acceptance: fresh install, sequential upgrade, failed migration recovery, and repeat execution are tested; no production schema push. Evidence: `E-DB-02` database migration integration report. Depends: DB-01.
- [ ] **DB-03 — Replace every Prisma call site.** Route/page/auth/script imports use the shared Drizzle node-postgres database modules; pool lifecycle is correct under development reload and shutdown. Acceptance: source/runtime dependency scan has no active Prisma client, generated client, adapter, or runtime command. Evidence: `E-DB-03` scan plus request/script tests. Depends: DB-02, AUTH-01, ING-04, DOM-05.
- [ ] **DB-04 — Establish query indexes and time conventions.** Add measured reader/read/save/search/Hot/job indexes, safe numeric conversions, UTC and collation tests. Acceptance: representative queries have documented plans and no full-table response loading where pagination is required. Evidence: `E-DB-04` query plans and precision fixtures. Depends: DB-02.
- [ ] **DB-05 — Remove obsolete Prisma artifacts safely.** After importer and replacement checks pass, retire schema/generated artifacts/dependencies and update lock/setup scripts without touching source databases. Acceptance: clean install/build/test uses only selected Drizzle stack; preserved exports remain restorable. Evidence: `E-DB-05` dependency and clean-environment report. Depends: DB-03, MIG-05, MIG-06.

### Migration and preservation

- [ ] **MIG-01 — Build safe source extraction and decoding.** Read selected prefixed source tables or export with bounded array/scalar PHP/base64 decoder. Acceptance: malicious serialization, encoding errors, and accidental secret output fail closed. Evidence: `E-MIG-01` decoder/extractor fixture tests. Depends: FND-04.
- [ ] **MIG-02 — Implement dry-run inventory and fingerprints.** Count/hash every table/field set; detect ownership, IDs, collisions, orphans, duplicates, malformed dates, and credentials. Acceptance: target unchanged and every issue reported without secrets. Evidence: `E-MIG-02` dry-run manifest. Depends: MIG-01.
- [ ] **MIG-03 — Implement resumable original-ID import.** Import staged entities/credentials/preferences/state/links, set sequences, and record checkpoints. Acceptance: interruption/re-run cannot duplicate data, overwrite reading state, or cross source fingerprints. Evidence: `E-MIG-03` fault-injection run. Depends: MIG-02, DB-02, AUTH-01.
- [ ] **MIG-04 — Resolve ambiguous legacy records without loss.** Handle duplicate memberships, reused GUIDs, checksum collisions, orphan items/links, and unknown preference keys. Acceptance: every source row is imported, quarantined intact, or explicitly approved for retirement. Evidence: `E-MIG-04` signed issue reconciliation. Depends: MIG-02, DB-01.
- [ ] **MIG-05 — Support optional starter SQLite export/import.** Detect populated starter data, export read-only, preserve owner/ID mapping, and document fields absent from that schema. Acceptance: no reliance on broken Prisma generation and no silent URL-only merges. Evidence: `E-MIG-05` populated-starter fixture migration. Depends: MIG-03, MIG-04.
- [ ] **MIG-06 — Prove full data reconciliation.** Compare field digests, IDs, content, timestamps, memberships, saved/read sets, options, API pages, and frozen-clock Hot. Acceptance: zero unexplained differences; safe sanitization differences separately enumerated. Evidence: `E-MIG-06` machine-readable before/after comparison. Depends: MIG-03, MIG-04, HOT-03, API-03, DOM-06.
- [ ] **MIG-07 — Rehearse consistent source snapshot and restore.** Freeze source MyISAM writes or use verified lock/dump; restore to isolated target and execute rollback including target-write reconciliation. Acceptance: measured duration and documented no-loss procedure. Evidence: `E-MIG-07` rehearsal log with engine/freeze proof. Depends: MIG-06, OPS-03, OPS-05.

### Authentication and authorization

- [ ] **AUTH-01 — Implement hashed credential login.** Use vetted password hash, supported auth-library integration, safe errors/redirects, rate limiting, and no plaintext comparisons. Acceptance: valid legacy credentials migrate, invalid credentials reveal no owner information, and hashes never reach clients. Evidence: `E-AUTH-01` login/credential integration tests. Depends: DB-02.
- [ ] **AUTH-02 — Implement revocable sessions.** Add owner/epoch checks, secure cookie scope/expiry, logout/logout-all, and credential-change revocation. Acceptance: revoked, expired, forged, wrong-origin, and wrong-base-path sessions cannot access data. Evidence: `E-AUTH-02` session matrix. Depends: AUTH-01.
- [ ] **AUTH-03 — Guard every protected boundary.** Protect pages, modern APIs, job controls, media, imports/exports, and administration; enforce CSRF/origin on cookie mutations. Acceptance: anonymous/forged/cross-origin requests fail without side effects; public exceptions documented. Evidence: `E-AUTH-03` route authorization matrix. Depends: AUTH-02.
- [ ] **AUTH-04 — Replace password reminder with recovery.** Deliver local one-time reset/recovery and optional configured mail path only if approved. Acceptance: reset tokens expire, are single-use, and revoke sessions; no password disclosure. Evidence: `E-AUTH-04` recovery tests/runbook. Depends: AUTH-02.
- [ ] **AUTH-05 — Secure first-run initialization.** Implement installation token, singleton-owner race prevention, minimum config preflight, and permanently closed setup after initialization. Acceptance: concurrent setup or unauthenticated reinitialization cannot seize an existing instance. Evidence: `E-AUTH-05` bootstrap tests. Depends: AUTH-01, DB-02.

### Ingestion and content

- [ ] **ING-01 — Build bounded safe HTTP transport.** Validate all fetch/redirect/DNS destinations, TLS, credentials, size, and deadlines. Acceptance: SSRF/rebinding/redirect/credential-leak/oversized-response fixtures fail safely across every consumer. Evidence: `E-ING-01` network adversarial suite. Depends: FND-04.
- [ ] **ING-02 — Implement discovery and protected feeds.** Handle feed/site URLs, alternate discovery, Basic auth encryption, auth-required retry, custom titles, and redirect identity. Acceptance: 401/failure does not erase content or leak credentials; user updates resume ingestion. Evidence: `E-ING-02` local fixture-server scenarios. Depends: ING-01, DB-02, AUTH-03.
- [ ] **ING-03 — Implement full RSS/Atom parsing.** Cover source namespace/content/link/author/date/encoding behavior and capped response policy. Acceptance: full HTML and metadata match golden fixtures; undated/future entries stay stable on repeat. Evidence: `E-ING-03` parser corpus report. Depends: ING-01, TEST-02.
- [ ] **ING-04 — Implement feed-scoped identity/update merge.** Store full UID with legacy aliases, fallback identity, same-link separate GUIDs, updates, and atomic link replacement. Acceptance: retries/concurrency create no duplicates or read/saved resets; conflicts are visible. Evidence: `E-ING-04` idempotency and conflict suite. Depends: ING-03, DB-02.
- [ ] **ING-05 — Implement versioned safe content rendering.** Store raw HTML privately, derive allowed text/images/rich modes, excerpts, resolved URLs, and text-node highlights. Acceptance: attack corpus cannot execute or escape the content boundary; normal formatting remains readable. Evidence: `E-ING-05` sanitizer/render snapshots. Depends: ING-03, AUTH-03.
- [ ] **ING-06 — Implement favicon pipeline and recache.** Migrate IDs/payloads, discover/fetch/validate/cache icons, default fallback, API encoding, and recache commands. Acceptance: malicious/missing icons remain safe, IDs survive, and cache validators work. Evidence: `E-ING-06` favicon contract tests. Depends: ING-01, DB-02.
- [ ] **ING-07 — Implement authorized media/hotlink handling.** Restrict proxy to associated media, validate MIME/size, scope caches, and preserve image preference behavior. Acceptance: arbitrary URL/other-scope access fails; protected content is not publicly cached. Evidence: `E-ING-07` media integration tests. Depends: ING-01, ING-05, AUTH-03.
- [ ] **ING-08 — Implement retention and reprocessing.** Preserve saved items, apply unsaved/link expiration, reweight survivors, and version re-sanitization separately from ranking. Acceptance: boundary/save races cannot delete newly saved content, and migration hold prevents premature cleanup. Evidence: `E-ING-08` retention/reprocessing suite. Depends: ING-04, HOT-02, DOM-04.

### Refresh and background work

- [ ] **JOB-01 — Implement durable scheduler and leases.** Enqueue due work with priority, job/feed deduplication, leases, fencing, retries, jitter, and host limits. Acceptance: two workers cannot commit conflicting refreshes and a dead worker’s lease recovers. Evidence: `E-JOB-01` concurrency/crash suite. Depends: DB-02, ING-04, ING-02.
- [ ] **JOB-02 — Implement manual refresh scopes.** Support all/group/feed and forced refresh, conditional HTTP, favicon option, failure state, and queue admission limits. Acceptance: scope matches source and force does not bypass network/resource protections. Evidence: `E-JOB-02` refresh scope tests. Depends: JOB-01, DOM-02.
- [ ] **JOB-03 — Implement progress, cancel, and UI refresh policy.** Show feed counts/status/errors and resume state; cancel safely; honor auto-reload without losing reading position. Acceptance: browser closure/reopen does not orphan work and failures do not falsely report completion. Evidence: `E-JOB-03` browser/job tests. Depends: JOB-02.
- [ ] **JOB-04 — Implement browser and operator scheduling.** Preserve auto-refresh preference purpose, add authenticated scheduler/local CLI, document migration from public cron URL. Acceptance: no anonymous workload trigger; schedule works with browser closed and no overlapping interval leak. Evidence: `E-JOB-04` scheduler integration/runbook test. Depends: JOB-01, AUTH-03.

### Reader domain

- [ ] **DOM-01 — Implement feed CRUD and unsubscribe.** Validate URLs/options/credentials, preserve custom titles, detect duplicates, and preview cascade impact including saved content. Acceptance: successful operations are transactional; cancel/failure leaves state intact. Evidence: `E-DOM-01` feed lifecycle tests. Depends: DB-02, AUTH-03, ING-02.
- [ ] **DOM-02 — Implement groups and many-to-many membership.** Add/edit/delete with optional unsubscribe, accessible membership commands, virtual group rules, and duplicate protection. Acceptance: one feed can be in several groups; deleting one membership does not unsubscribe it. Evidence: `E-DOM-02` relationship lifecycle tests. Depends: DOM-01.
- [ ] **DOM-03 — Implement Sparks.** Preserve hidden affiliations, promote/demote, default auto-Spark, bulk edit/delete, counts, and Hot inclusion. Acceptance: all section/API membership boundaries match fixtures. Evidence: `E-DOM-03` Spark matrix. Depends: DOM-02.
- [ ] **DOM-04 — Implement reading and saving commands.** Item read/unread/save/unsave, UI save-as-read, bulk cutoff scopes, concurrent arrivals, operation journal, and approved recently-read behavior. Acceptance: no post-cutoff item accidentally marked read; counts recover on failed optimistic actions. Evidence: `E-DOM-04` state/concurrency suite. Depends: DB-02, AUTH-03.
- [ ] **DOM-05 — Implement list/search/saved queries.** All section/feed/group scopes, literal/legacy search decision, stable order/pagination, and correct counts. Acceptance: shrinking unread lists and concurrent new items cause no skips/duplicates; source substring tests pass. Evidence: `E-DOM-05` query contracts. Depends: DOM-03, DOM-04, DOM-06.
- [ ] **DOM-06 — Implement preference inheritance and view state.** Map every preference, -1 inheritance, separate reading versus auth sessions, mobile options, and navigation persistence. Acceptance: full global/group/feed cross-product and section isolation pass. Evidence: `E-DOM-06` preference/state fixtures. Depends: DB-02.

### Hot

- [ ] **HOT-01 — Port URL and link occurrence semantics.** Implement legacy normalization/wrapper/ignore rules with versioning and collision checks. Acceptance: occurrence inputs match golden source fixtures without global URL deduplication. Evidence: `E-HOT-01` canonicalization/extraction tests. Depends: ING-03, TEST-01.
- [ ] **HOT-02 — Port per-feed weighting and scoring.** Preserve first/repeat flags, penalty, time window, ordering, limit-before-threshold, and source collection phases. Acceptance: intermediate score/ID outputs match golden fixtures. Evidence: `E-HOT-02` exact pipeline report. Depends: HOT-01, ING-04.
- [ ] **HOT-03 — Port representatives, titles, temperatures, and sources.** Preserve source preference rules, description policy, tie characterization, rounding, and source time filtering. Acceptance: UI/API final objects and temperatures match fixtures with documented tie-only differences. Evidence: `E-HOT-03` representative/render contract tests. Depends: HOT-02.
- [ ] **HOT-04 — Implement blacklist rules and recomputation.** Exact URL/domain/imported regex rules with bounded matching, previews, invalid-rule reports, and reapplication. Acceptance: editing rules updates existing and new occurrences consistently without regex denial of service. Evidence: `E-HOT-04` blacklist corpus/recompute tests. Depends: HOT-01, AUTH-03.
- [ ] **HOT-05 — Validate real migrated Hot parity.** Run old and new derived results from identical frozen dataset/time and inspect every discrepancy. Acceptance: no unexplained score/order/title/source/save difference and no source-content loss. Evidence: `E-HOT-05` signed parity comparison. Depends: MIG-06, HOT-04, PG-04.

### Fever API

- [ ] **API-01 — Preserve root query routing.** Implement transparent root `?api` dispatch under root and subpath deployments. Acceptance: form POST body/query combinations reach compatibility handler with no redirect or auth HTML. Evidence: `E-API-01` reverse-proxy/route test. Depends: FND-04.
- [ ] **API-02 — Implement digest authentication and rotation.** Import digest verifier, exact bytes/case rules, generic failure envelope, rate limits, and planned rotation. Acceptance: existing valid digest works without plaintext password storage; revoked key fails. Evidence: `E-API-02` credential compatibility tests. Depends: AUTH-01, MIG-03.
- [ ] **API-03 — Implement every read query and serializer.** Groups/relationships, feeds, icons, items/selection precedence, links, ID lists, combined flags, JSON/XML, and empty cases. Acceptance: field/type/ID/paging contract matches golden tests. Evidence: `E-API-03` full v3 contract report. Depends: API-01, API-02, DOM-05, HOT-03, ING-06.
- [ ] **API-04 — Implement whitelisted mutations.** All working item/feed/group operations, automatic state ID-list responses, and documented no-op link stubs. Acceptance: no arbitrary method invocation or invalid scope mutation; bulk time bounds pass. Evidence: `E-API-04` mutation matrix. Depends: API-03, DOM-04.
- [ ] **API-05 — Verify a real client synchronization lifecycle.** Use the user’s selected client against staging with migrated IDs. Acceptance: initial sync, incremental sync, read/save, group/Spark data, Hot, and credential rotation work without resubscription/data duplication. Evidence: `E-API-05` client acceptance recording/log. Depends: API-04.
- [ ] **API-06 — Prove API isolation and resource behavior.** Bound bodies/list params/paging, redact credentials, avoid shared caches, and profile large unread/saved lists. Acceptance: compatibility preserved at representative scale and invalid requests fail safely. Evidence: `E-API-06` load/security report. Depends: API-04, AUTH-03.

### Desktop, mobile, and accessibility

- [ ] **UI-01 — Preserve assets and visual identity.** Inventory/copy permitted assets, replace scaffold branding, establish original palette/type/temperature/card states and optional CSS hooks. Acceptance: reviewer recognizes Fever across desktop/mobile without generated replacement art. Evidence: `E-UI-01` asset manifest and visual comparison. Depends: FND-04.
- [ ] **UI-02 — Build navigation and reader shell.** Responsive panes/drill-down, section/group/feed selection, alpha navigation, show-read/feeds, URL/history/scroll state. Acceptance: keyboard/touch Back/Forward/reload restore intended state. Evidence: `E-UI-02` navigation browser suite. Depends: UI-01, DOM-05, AUTH-03.
- [ ] **UI-03 — Build Hot presentation.** Ranges, thermometer groups, sources, original content, blacklist/save/read, loading/empty/multipage states. Acceptance: rendered IDs/order/actions agree with HOT results on desktop and mobile. Evidence: `E-UI-03` Hot visual/action tests. Depends: UI-02, HOT-03.
- [ ] **UI-04 — Build article stream and detail.** New/unread/read/saved/focus states, author/date/feed, excerpt/full, images, source visits, auto-read, pagination, and errors. Acceptance: state/read-policy tests pass without focus loss or accidental preloaded-item reads. Evidence: `E-UI-04` article state matrix. Depends: UI-02, ING-05, DOM-04.
- [ ] **UI-05 — Build every management surface.** Feed/group/Sparks dialogs, preferences, credentials, blacklist, import/export, Help/Extras, about/updates, maintenance entry, and errors. Acceptance: all source form actions have accessible equivalents, validation, pending/retry, cancel, and success states. Evidence: `E-UI-05` management workflow matrix. Depends: UI-02, DOM-06, DOM-02, DOM-03.
- [ ] **UI-06 — Implement command registry and accessibility.** All documented/actual shortcuts, service conflicts, menus/dialog focus, no input/IME interception, drag alternative, screen-reader labels, contrast, zoom, and reduced motion. Acceptance: manual keyboard/screen-reader plus automated accessibility checks pass supported states. Evidence: `E-UI-06` command/a11y report. Depends: UI-02, UI-05.
- [ ] **UI-07 — Finish mobile and installation metadata.** Article previous/next, back-out/read policy, external navigation/embed fallback, touch targets, portrait/landscape/tablet, safe shell-cache decision, and webclip assets. Acceptance: real mobile browsers pass workflow/zoom/history tests; no false offline-reading claim. Evidence: `E-UI-07` mobile acceptance matrix. Depends: UI-03, UI-04, UI-06.
- [ ] **UI-08 — Prove full state and visual coverage.** Empty install, many feeds, locked/broken feed, no matches, saved-only, all read, long titles/content, busy/failed refresh, expired session, and narrow/large displays. Acceptance: no unexplained dropped surface or blocker in representative screenshots/interactions. Evidence: `E-UI-08` visual regression and user review. Depends: UI-07, JOB-03.

### Imports, sharing, and integrations

- [ ] **INT-01 — Implement OPML import/export.** Bounded safe XML, group/flatten/include-Sparks options, nested outlines, reserved names, duplicates, multi-group feeds, previews, progress, and readable errors. Acceptance: round-trip preserves subscriptions/memberships/options supported by OPML, with explicit limits versus full backup. Evidence: `E-INT-01` OPML round-trip corpus. Depends: DOM-02, AUTH-03.
- [ ] **INT-02 — Implement Feedlet and subscription entry.** Preserve old URL forms/candidates/format choices/options/login return; offer navigation fallback for CSP restrictions; commit via protected POST. Acceptance: no GET mutation/open redirect/SSRF, duplicates handled, subscribed/missing/guess/auth states visible. Evidence: `E-INT-02` Feedlet scenarios. Depends: ING-02, DOM-02, AUTH-03.
- [ ] **INT-03 — Implement Saved RSS publishing.** Off by default for fresh install, preserve reviewed imported setting, 30 newest saved, compatible GUID/base path, XML, discovery, and protected-content policy. Acceptance: disabled feed is unavailable; public/private decisions are explicit; no secret feed URL leakage. Evidence: `E-INT-03` RSS/privacy contract. Depends: DOM-04, ING-05, DOM-06.
- [ ] **INT-04 — Implement safe custom services.** Preserve original ordered settings, encode %t/%u/%e, support approved destinations/background mode, show shortcut conflicts, and disable unsafe templates visibly. Acceptance: no script execution/invisible automatic transmissions; user-triggered working services verified. Evidence: `E-INT-04` template/security/browser tests. Depends: DOM-06, AUTH-03.

### Deployment, maintenance, and recovery

- [ ] **OPS-01 — Implement reproducible deployment/preflight.** Pin runtime/package/database versions, build artifact, web/worker supervision, base-path/TLS proxy, env validation, health checks, and resource limits. Acceptance: fresh isolated install works from documented inputs with no PHP/vendor dependency. Evidence: `E-OPS-01` clean deployment report. Depends: DB-02, AUTH-05, JOB-01.
- [ ] **OPS-02 — Implement diagnostics and observability.** Structured redacted logs, request/job correlation, safe per-feed diagnostics, metrics, worker/backup alerts, and operational error pages. Acceptance: induced feed/DB/job/backup failure is identifiable without secrets. Evidence: `E-OPS-02` failure-drill output. Depends: OPS-01, JOB-03.
- [ ] **OPS-03 — Implement complete backup and restore.** Include all state/credentials/migration metadata and recoverable encryption keys with agreed retention. Acceptance: restored isolated instance has matching data/credentials/Hot and measured RPO/RTO. Evidence: `E-OPS-03` restore comparison. Depends: DB-02, MIG-03.
- [ ] **OPS-04 — Implement upgrade/rollback release flow.** Immutable artifacts, schema lock, compatibility gate, local changelog, health-based promotion, and previous artifact recovery. Acceptance: failed migration/deploy leaves a documented recoverable state; no request-time self-modification. Evidence: `E-OPS-04` upgrade/failure drill. Depends: OPS-01, OPS-03.
- [ ] **OPS-05 — Implement recovery and post-write rollback.** Operator auth recovery, stalled-job repair, old/new database handling, target mutation replay, key restoration, and offline PHP fallback. Acceptance: rollback retains activities performed during the trial window or explicitly reconciles them. Evidence: `E-OPS-05` recovery rehearsal. Depends: OPS-03, DOM-04, MIG-03.
- [ ] **OPS-06 — Implement maintenance and uninstall equivalents.** Safe cache clear, orphan report, flush, empty, and uninstall with previews/backups/reauthentication/scoped confirmation. Acceptance: cancel is side-effect-free; execution touches only selected installation data; saved-content consequences explicit. Evidence: `E-OPS-06` destructive-workflow fixture report. Depends: OPS-03, AUTH-03, DOM-01.

### Verification, cutover, and closure

- [ ] **QA-01 — Run the required automated suite.** Typecheck, lint, production build, unit/domain/parser/sanitizer/Hot tests, PostgreSQL integration, migration fault tests, API contracts, and browser workflows. Acceptance: all required checks pass on exact release artifact; no quarantined blocker disguised as pass. Evidence: `E-QA-01` indexed logs/results. Depends: UX-01, UX-02, UX-03, UX-04, UX-05, UX-06, UX-07, UX-08, UX-09, UX-10, UX-11, UX-12, UX-13, UX-14, UX-15, UX-16, UX-17, UX-18, UX-19, UX-20, UX-21, UX-22, UX-23, UX-24, UX-25, UX-26, UX-27, UX-28, UX-29, UX-30, UX-31, UX-32, UX-33, UX-34, UX-35, UX-36, UX-37, UX-38, UX-39, UX-40, UX-41, TEST-01, TEST-02, TEST-03, TEST-04, TEST-05, TEST-06, TEST-07, TEST-08, TEST-09, TEST-10, TEST-11, TEST-12, PG-01, PG-02, PG-03, PG-04, PG-05, PG-06, PG-07, PG-08, HOT-05, MIG-07, ING-08, INT-04, OPS-06, JOB-04, OPS-02.
- [ ] **QA-02 — Run scoped adversarial verification.** Review only migration changes for auth/CSRF/SSRF/XML/HTML/SQL/credential/backup leaks, concurrency, and data loss. Acceptance: actionable findings fixed/retested or explicitly accepted without violating required safety. Evidence: `E-QA-02` findings/disposition report. Depends: QA-01.
- [ ] **QA-03 — Measure realistic scale and usability.** Representative large migrated dataset, repeated refresh/retention, desktop/mobile accessibility, selected API client, and resource budgets. Acceptance: agreed performance budgets pass and all user workflows remain usable. Evidence: `E-QA-03` measured benchmark/usability record. Depends: TEST-09, UX-41, TEST-12.
- [ ] **QA-04 — Reconcile source-to-feature coverage.** Mechanically validate every inventory route/action/template/preference/command/asset has a completed task and passing test or approved retirement. Acceptance: zero unclassified/unmapped/unchecked required rows. Evidence: `E-QA-04` coverage report. Depends: QA-01, FND-01, DOC-01.
- [ ] **CUT-01 — Prepare the concrete cutover package.** Final artifact/schema/source snapshot plan, maintenance notice, freeze steps, exact origin/path switch, health checks, backup and rollback instructions. Acceptance: package is reviewable and rehearsed before requesting production approval. Evidence: `E-CUT-01` approved runbook/checklist. Depends: QA-01, QA-02, QA-03, QA-04, DOC-01.
- [ ] **CUT-02 — Execute authorized final migration and switch.** Freeze every legacy writer, take consistent final backup, import/reconcile, switch origin, verify exact artifact, then enable one worker. Acceptance: login/reader/API/RSS/refresh/state changes pass against actual production origin. Evidence: `E-CUT-02` production verification manifest. Depends: CUT-01, PG-08.
- [ ] **CUT-03 — Complete the observation and rollback window.** Monitor agreed meaningful failure/health signals, resolve migration defects, verify scheduled work/backups, and obtain acceptance. Acceptance: no unexplained divergence; old artifacts remain recoverable until approved retirement. Evidence: `E-CUT-03` observation/acceptance record. Depends: CUT-02.
- [ ] **DOC-01 — Finish operator/user documentation.** Replace Prisma/obsolete setup text, document every safe adaptation/integration/recovery/maintenance behavior, retain notices, and provide keyboard/help content. Acceptance: a fresh operator can install, import, refresh, back up, restore, and recover using only the docs. Evidence: `E-DOC-01` documentation walkthrough. Depends: UI-05, UI-06, INT-01, INT-02, OPS-04, OPS-05, OPS-06.
- [ ] **TRACE-01 — Publish the 100% completion ledger.** Attach all evidence, accepted decisions, final source/artifact/schema versions, source inventory mapping, and remaining out-of-scope enhancements. Acceptance: all required tasks checked, no pending retirement or blocker, actual production proof distinct from synthetic QA. Evidence: `E-TRACE-01` final completion report. Depends: CUT-03, DOC-01, QA-04.

## 13. Traceability and evidence format

The table below is the minimum crosswalk. FND-01 expands it to every concrete file/surface and generates a mechanically checked CSV/JSON ledger; the table is not permission to treat a whole directory as covered by one screenshot.

| Feature family | Source refs | Tasks | Required test/evidence family |
|---|---|---|---|
| Schema and complete persistence | S01, S05, S18 | DB-01–05, MIG-01–07 | Constraint, serialization, exact-ID/digest, resume, restore |
| Login/logout/recovery/setup | S02, S04, S05, S17, S18 | AUTH-01–05, OPS-01 | Session, authorization, CSRF, recovery, bootstrap race |
| All root/query routes and 20 management cases | S02–S04 | FND-01, API-01, QA-04, corresponding DOM/INT/OPS | Route/action inventory and endpoint contract |
| Fever API v3 and third-party clients | S03, S09, S10 | API-01–06 | JSON/XML, paging/preference, mutations, actual-client sync |
| Feed fetch/discovery/auth/refresh | S04, S06–S08, S12 | ING-01–04, JOB-01–04 | RSS/Atom fixture server, safe fetch, lease/crash/retry |
| Content, excerpts, images, icons | S07–S09, S11–S16 | ING-05–07, UI-04 | Sanitization, media authorization, favicon wire data, visual |
| Retention, source timestamps, saved survival | S07, S09, S15 | ING-08, MIG-06, DOM-04 | Expiry/save race and preserved-state digests |
| Hot parsing, weights, ranking, source labels | S08–S11, S13–S14, S16 | HOT-01–05, UI-03, API-03 | Frozen-clock intermediate/final parity, boundaries/ties/pages |
| Blacklist exact/domain/regex behavior | S04, S08–S09, S15 | HOT-04, UI-05 | Rule grammar, bounded matching, reapplication |
| Groups/Kindling/Sparks/counts/CRUD | S06, S09–S10, S13–S16 | DOM-01–03, UI-02, UI-05 | Many-to-many/group/Spark/count/deletion cross-product |
| Read/save/new/bulk/undo/paging | S09–S10, S13–S14, S16 | DOM-04–06, UI-04 | Cutoff/concurrency, reading-session boundary, unread shrinking |
| Search/Saved and per-feed filters | S10, S13–S16 | DOM-05, UI-02, UI-04 | Substring/collation/highlight/count and pagination |
| Global/group/feed/mobile preferences | S01, S04, S09, S15–S16 | DOM-06, UI-05, UI-07 | Exhaustive key mapping and inheritance/context matrix |
| Desktop identity/assets/theme overrides | S09, S13–S15 | UI-01–06, DOC-01 | Asset manifest, source comparison, override migration, a11y |
| Mobile screens/history/read options/Elsewhere | S04, S16 | UI-02, UI-04, UI-07–08 | Mobile real-browser paths, zoom, back/scroll and embed fallback |
| Keyboard, menus, dialogs, drag, help | S14–S16 | UI-05–06, DOC-01 | Command registry, focus/IME/shortcuts, screen-reader |
| OPML import/export | S06, S15 | INT-01, MIG-05 | Nested/group/Sparks/flatten/duplicate/round-trip |
| Feedlet/subscription/Extras | S04, S09, S15–S16 | INT-02, JOB-04, DOC-01 | Old/new URL, CSP fallback, login return, confirmation |
| Saved RSS | S02, S15 | INT-03 | 30-item/GUID/XML/discovery/public-protected privacy |
| Sharing templates/referrer options | S01, S14–S15 | INT-04, DOM-06, UI-06 | Encoding, protocol/background/shortcut conflict |
| Maintenance/uninstall/updater/recovery | S02, S05, S07, S17 | OPS-01–06, DOC-01 | Preview/confirmation, no self-delete, restore/upgrade drill |
| Production migration/cutover/readiness | All | QA-01–04, CUT-01–03, TRACE-01 | Exact artifact, consistent final snapshot, real-origin acceptance |

Each task evidence record must include: task ID; status; acceptance criterion IDs; test names; source baseline digest; implementation revision/artifact digest; schema/policy versions; environment; run date; relevant frozen clock/data fingerprint; links to result logs/screenshots/reconciliation outputs; actual versus expected summary; any exceptions with approval pointer; reviewer. Redact secrets. A passing synthetic dataset test is never labeled as production verification.

Report progress as `completed required tasks / total required tasks`, plus completed inventory rows and blocking decisions. Do not average feature completeness away by completing many documentation items. All tasks in this specification are required unless a row is explicitly retired with approval. Splitting a task creates children without deleting the original acceptance obligations. Adding a newly discovered legacy surface expands the ledger and denominator. An implementation can be “development complete” while cutover remains 0%; the final “100% migrated” label requires all applicable CUT/TRACE gates.

## 14. Decision log and material unresolved questions

These questions require real deployment, privacy, or product decisions. They do not block source-based implementation planning, and implementation should complete independent work while decisions are pending.

1. **Production host:** PostgreSQL is selected. Confirm the actual host/base URL/path, supported PostgreSQL major, TLS/pooling/storage arrangement, extensions, and whether a worker can run continuously. Database-engine selection is no longer an open question.
2. **Data source:** does a live legacy database exist, is there a populated starter database, and which is authoritative if both have activity? What downtime/freeze window is acceptable? Data export/credentials need scoped authorization when implementation reaches them.
3. **Client compatibility:** which real Fever clients and saved base URL must survive? Preserve existing API digest initially, and define password/key rotation and recovery expectations.
4. **Public saved content:** preserve imported `share` publication exactly, require private-feed exclusion, or transition to an unguessable token? Source currently publishes protected-feed saved content too. Any privacy tightening can change existing consumers and needs an explicit migration choice.
5. **Safe behavior changes:** approve safe rich HTML replacing unfiltered injection, secure recovery replacing password reminder, confirmation replacing GET subscribe, authenticated scheduling replacing public refresh, safe service-template restrictions, and operation-scoped undo replacing the source undo anomaly. Unsafe mechanisms will not be reproduced; approval selects the documented equivalent or a visible deferred surface.
6. **Deletion and rollback policy:** should unsubscribe continue deleting saved items after an explicit preview, or retain them under an archived feed? Source deletes them; preservation is a useful product change but cannot be silently imposed. Define backup retention and post-cutover write reconciliation/RPO/RTO.
7. **Disabled/obsolete mechanisms:** approve retirement of AppCache, vendor activation/updater/re-download, PHP bootstrap/safety scripts, automatic request-time MyISAM repair, and obsolete browser requirements after their modern equivalents and notices are complete.
8. **Private feed origins and custom themes/services:** identify required private-network feeds, currently used custom CSS, and nonstandard service templates when authorized source configuration is inspected. Keep granular allowlists and explicit adaptation reports.
9. **Distribution:** is this a private migration only, or is redistributing legacy code/assets expected? Existing copyright and EULA notices require a separate rights determination before packaging publicly.

The principal migration risks are accidental state loss through URL deduplication or UID changes; inconsistent MyISAM export; invalidating existing API clients/IDs; subtle Hot phase/normalization/collation differences; plaintext/API/feed credential exposure; SSRF through non-feed fetch paths; source HTML execution; skipped unread pagination; accidental public sharing of private feed content; incomplete mobile/keyboard/maintenance parity; and rollback that ignores writes made after cutover. The checklist treats each as a verification obligation, not an assumption.

## 15. Granular product and visual acceptance checklist

These are required acceptance tasks under the implementation tasks in section 12. Each task has its own evidence ID `E-<task ID>` and must link a named test and, for visual behavior, a screenshot or short recording. Passing one screenshot cannot complete an entire feature family. Dependencies identify the implementation that must exist before acceptance; test fixtures and expected states can be written earlier.

Use the same frozen fixture data and clock for old and new screenshots. Capture desktop at 1024×768 and 1440×900, compact layouts at 375×812 and 390×844, and tablet at 768×1024; cover portrait and landscape. Run Chromium and WebKit automation, then the actual supported desktop and mobile browsers. These are acceptance targets, not screenshots already captured. Reference font rendering, asset scale, spacing, borders, colors, content wrapping, and interactive states. Record intentional accessibility changes separately from accidental style regressions.

### Identity, navigation, and articles

- [ ] **UX-01 — Verify identity and base styles.** Depends: UI-01. Fever logo, degree mark, favicon, home-screen icons, tab metadata, light gray/red palette, Helvetica-family hierarchy, and normal/retina assets render without starter branding or missing requests. Preserve the source light theme by default; a new dark theme is separate scope. Evidence: desktop/mobile screenshots and asset request report.
- [ ] **UX-02 — Verify fixed/fluid panes and feed visibility.** Depends: UI-02. Both layout preferences, optional feed pane, independent sidebar scrolling, long group/feed titles, narrow width, and 200% zoom remain usable without overlap or unreachable controls. Evidence: responsive geometry matrix.
- [ ] **UX-03 — Verify all section and scope transitions.** Depends: UI-02, DOM-05. Hot, Kindling, custom group, Saved, Sparks, and Search select correct data/counts; virtual All rows work; selecting a feed from Hot/Saved chooses its proper section without inheriting an unrelated group. Evidence: navigation tests.
- [ ] **UX-04 — Verify history, scroll, and stale-response handling.** Depends: UI-02. Back, Forward, reload, deep links, compact-layout override, panel scroll positions, and search return restore the intended state. Slow earlier requests cannot overwrite newer selection. Evidence: delayed-response browser tests.
- [ ] **UX-05 — Verify feed and group row states.** Depends: UI-01, UI-02, ING-06. Favicons, locked/abandoned/error states, counts, read opacity, focus, selected state, drag target, alphabet jump, and long names are legible. Controls work with keyboard and touch. Evidence: state screenshots and interactions.
- [ ] **UX-06 — Verify article state combinations.** Depends: UI-04, DOM-04, DOM-06. New, unread, read, saved, focused, collapsed, and expanded states remain distinguishable, including saved-plus-new precedence. The six-minute reading boundary changes New independently of authentication lifetime. Evidence: frozen-clock state matrix.
- [ ] **UX-07 — Verify article typography and containment.** Depends: UI-04, ING-05. Headings, paragraphs, nested lists, definition lists, blockquotes, links, tables, pre/code, Unicode, wide images, and broken images retain readable structure. Tailwind resets cannot flatten content styling; long content cannot overflow the reader shell. Evidence: rich-content screenshots and sanitizer assertions.
- [ ] **UX-08 — Verify excerpt and full-content switching.** Depends: UI-04, DOM-06. Global/group/feed inheritance and each text/images/rich mode apply to existing articles, lazy full-content loading, click-toggle preference, Enter, and zero. Ordinary links do not trigger unintended toggles. Evidence: inheritance and interaction tests.
- [ ] **UX-09 — Verify dates, authors, and title formatting.** Depends: UI-04, ING-03. Missing author/title, relative date boundaries, source links, title nonbreaking-space behavior, and periodic relative-time refresh match characterized output without invalid hydration. Evidence: frozen-time formatter tests and screenshots.
- [ ] **UX-10 — Verify read/save and optimistic failure recovery.** Depends: UI-04, DOM-04. UI save marks a backing item read, unsave preserves the correct read state, counts reconcile, duplicate clicks are idempotent, failed requests restore state, and a concurrent refresh cannot overwrite a newer user mutation. Evidence: controlled race tests.
- [ ] **UX-11 — Verify desktop scroll-to-read.** Depends: UI-04, DOM-04. Characterize source whole-item-bottom passing the 64px line (`reader.js:1623–1644`), scrolling direction, and programmatic-scroll guards. Any responsive offset adaptation is explicit. Preloaded pages and merely focused items must not be marked accidentally. Evidence: scroll boundary tests.
- [ ] **UX-12 — Verify all paging modes.** Depends: UI-04, DOM-05. At least three pages of unread/all/saved/search results work in both sort orders while auto-read removes rows and new items arrive. No duplicate/skipped IDs, focus loss, or unexpected scroll jump; end-of-list navigation reaches the next unread scope. Preserve the purpose of source bottom reading space without hardcoding unusable mobile padding. Evidence: ID-sequence assertions.
- [ ] **UX-13 — Verify empty and error states.** Depends: UI-08. Separate no subscriptions, empty group, empty feed, no unread, no saved, blank search, no matches, authentication-required feed, failed view request, and expired session. Each message has a working relevant action, preserves entered values, and avoids outdated hover-only instructions. Evidence: one screenshot and action assertion per state.
- [ ] **UX-14 — Verify Hot presentation and empty guidance.** Depends: UI-03, HOT-03. Temperature integer/decimal alignment, red degree/bar, source list, local item content, source read state, F/C toggle, selected range/start menus, pagination, and week/month/add-feeds empty guidance work. Only actual backing items expose effective save actions. Evidence: golden Hot screenshots and action tests.
- [ ] **UX-15 — Verify title and app badges.** Depends: UI-02, DOM-05. Unread preference controls document-title count; Sparks do not inflate Kindling unread totals. Platform badges are progressive enhancement with a working title fallback. Evidence: count assertions before/after mutations.

### Commands, forms, and management

- [ ] **UX-16 — Verify every keyboard command.** Depends: UI-06. Exercise the full registry in section 9, actual-source aliases, modifier guards, input/contenteditable/IME exceptions, menus, and service-key conflicts. Help displays the same registry. Evidence: table-driven command assertions and manual keyboard pass.
- [ ] **UX-17 — Verify menus.** Depends: UI-05, UI-06. Action, group, feed, item, Sparks, Hot start, and Hot range menus preserve action availability, selected/disabled states, dividers, and key labels; stay inside the viewport; dismiss appropriately; and restore focus. Evidence: seven-menu state matrix.
- [ ] **UX-18 — Verify dialogs and help.** Depends: UI-05, UI-06. Tabs, focus trap, queued dialogs, Enter except multiline inputs, Escape/modifier-period, cancellation, pending state, duplicate-submit prevention, inline validation, and return focus work. Help is reachable by focus/touch as well as the source delayed hover. Evidence: dialog and help tests.
- [ ] **UX-19 — Verify feed add/edit/authentication.** Depends: UI-05, DOM-01, ING-02. URL, optional title, groups, Spark, hotlinking, display overrides, and credentials work; errors retain form values; secrets are never prefilled; 401 prompts and successful retry are visible. Evidence: full form lifecycle.
- [ ] **UX-20 — Verify feed deletion consequences.** Depends: UI-05, DOM-01. Preview names the feed, all memberships, and affected saved items; cancel changes nothing; confirmed deletion follows the approved policy and resets stale navigation. Evidence: before/after counts and cancel test.
- [ ] **UX-21 — Verify group lifecycle.** Depends: UI-05, DOM-02. Reserved Kindling, duplicate-name behavior, multi-feed selection, inherited display settings, and membership replacement are characterized. Deleting only a group leaves its feeds; optional unsubscribe previews shared memberships and saved items, and respects the source Spark exception. Evidence: lifecycle tests.
- [ ] **UX-22 — Verify Sparks and membership movement.** Depends: UI-05, DOM-03. Bulk edit/delete, auto-Spark, promote/demote, drag ghost/target, and menu alternatives work. Hidden memberships survive Spark toggles; dropping onto Remove affects the intended membership. Evidence: keyboard/pointer/touch tests.
- [ ] **UX-23 — Verify all preference tabs.** Depends: UI-05, DOM-06. Behavior, Display, Refreshing, Sharing, and Login validate, save, reload, and show errors correctly. Every key in section 17 is covered, including non-UI defaults; password change requires current authentication and explains client/session invalidation. Evidence: per-key persistence matrix.
- [ ] **UX-24 — Verify refresh states.** Depends: JOB-03, UI-02. Queued/running/feed-auth/favicon/cancelled/failed/completed states show accurate progress and last-refresh time. Reconnection reads persisted job state instead of blindly launching duplicate work after a stalled stream. Auto-reload preserves reading position. Evidence: disconnect/restart/cancel browser recording.
- [ ] **UX-25 — Verify blacklist editing.** Depends: HOT-04, UI-05. Add exact URL/domain rule, edit imported regex, invalid/expensive-rule feedback, Save and Filter progress, and cancellation work; old and new links agree after recomputation. Evidence: rule and browser tests.
- [ ] **UX-26 — Verify service templates and outbound links.** Depends: INT-04, UI-06. Title/URL/excerpt substitution, encoding, shortcut conflicts, new-window behavior, referrer anonymity, visible disabled unsafe templates, and explicit background-service actions work without executing imported JavaScript. Evidence: controlled destinations and browser tests.
- [ ] **UX-27 — Verify custom stylesheet hooks.** Depends: UI-01. Both desktop and mobile override hooks have a documented loading order, migration report for incompatible selectors, and a recoverable disable path. Customization cannot hide the only recovery control. Evidence: sample-theme and fallback screenshots.

### Mobile, onboarding, and integrations

- [ ] **UX-28 — Verify mobile drill-down.** Depends: UI-07, UI-02. Groups → feeds → items → article, back titles, scroll offsets, browser history, orientation changes, and reduced-motion transitions work. Returning screens discard stale responses without discarding reading state. Evidence: mobile navigation recording.
- [ ] **UX-29 — Verify mobile read policies precisely.** Depends: UI-07, DOM-04. Source scroll logic uses 75% of row height. Source back-out marks all rendered unread rows in the items DOM for Kindling/Sparks, including rows outside the viewport; it does not mean only physically visible rows. Characterize that scope, preserve it by default, and require a recorded decision for viewport-only behavior. Fetch-only/preloaded data outside the rendered list is excluded. Evidence: multi-screen-height fixture with both preferences on/off.
- [ ] **UX-30 — Verify previous/next and swipe.** Depends: UI-07. Previous/next buttons, source 150px swipe baseline, first/last boundaries, next-page loading, saved toggle, horizontal content scrolling, and assistive-technology alternatives work. Any threshold adaptation for smaller screens is recorded. Evidence: mobile interaction tests.
- [ ] **UX-31 — Verify mobile settings and Hot.** Depends: UI-07, UI-03. Native Hot range/start controls, show-read/show-feeds, read-on-scroll/back-out, view-in-app, undo, and logout persist correctly without overwriting unrelated desktop navigation. Evidence: mobile settings matrix.
- [ ] **UX-32 — Verify external-article behavior.** Depends: UI-07. Preserve imported view-in-app preference intent; allowed embeds have constrained permissions and a visible external-open control. Blocked/failed frames offer a reliable fallback without claiming frame-policy bypass. Evidence: allowed and blocked fixture origins.
- [ ] **UX-33 — Verify mobile metadata and caching.** Depends: UI-07, OPS-01. Touch icons, install metadata, safe areas, orientation, browser zoom, and shell caching policy work. Logout invalidates private caches. Offline messaging must not claim cached articles unless a separately specified feature actually provides them. Evidence: online/offline/logout tests.
- [ ] **UX-34 — Verify login and recovery UI.** Depends: AUTH-01, AUTH-04, UI-01. Desktop/mobile branding, field labels, Enter/Go submission, generic errors, preserved email, safe return URL, reset expiry, and session expiry recovery work. Copy explains reset instead of offering to send an existing password. Evidence: browser/recovery tests.
- [ ] **UX-35 — Verify setup and existing-install protection.** Depends: AUTH-05, OPS-01. Preflight, owner/temperature setup, existing-target detection, use-existing path, explicit reset boundary, and getting-started OPML/Feedlet/subscription links work. Setup cannot be reopened after initialization. Evidence: fresh and existing database fixtures.
- [ ] **UX-36 — Verify Feedlet discovery and selection.** Depends: INT-02. Supplied candidates, server fallback, duplicate variants, subscribed/guessed/auth-required feeds, select-all, format choice, per-feed options, login continuation, cancel, and safe return work on desktop/mobile. A CSP-blocked bookmarklet has a usable navigation fallback. Evidence: multi-feed fixture page tests.
- [ ] **UX-37 — Verify subscription entry compatibility.** Depends: INT-02. Existing `?subscribe&url=` and modern URL reach the correct authenticated prefilled confirmation; GET alone has no mutation; POST adds/refreshes the chosen subscription. Evidence: old/new integration URL tests.
- [ ] **UX-38 — Verify OPML controls and round trip.** Depends: INT-01. Import-groups on/off, imported-title group, nested outlines, All/Sparks names, shared feeds, duplicate subscriptions, selected-group export, flatten, single-group flatten, and include-Sparks produce correct memberships and filenames. Evidence: export/reimport structural comparison.
- [ ] **UX-39 — Verify Saved RSS publication.** Depends: INT-03. Disabled/enabled behavior, 30-item publication order, stable GUIDs/base path, safe XML, login discovery, and the explicit protected-content policy pass. No password or signed subscription URL leaks. Evidence: HTTP/XML fixtures.
- [ ] **UX-40 — Verify secondary and maintenance pages.** Depends: UI-05, OPS-06, DOC-01. Extras, shortcuts, blacklist, local release notes, diagnostics/errors, empty, flush, orphan cleanup, and uninstall all have usable entry/exit paths and accurate consequences. Destructive actions require a current protected confirmation; cancelling leaves data unchanged. Evidence: page/workflow coverage.
- [ ] **UX-41 — Verify accessibility across states.** Depends: UX-01, UX-13, UX-17, UX-18, UX-28. Automated checks plus manual keyboard/screen-reader tests cover names, status announcements, focus, contrast, 200% zoom, reflow, 44px target design, reduced motion, and high-content-density screens. Preserve Fever identity while correcting inaccessible source patterns. Evidence: findings and resolved screenshots.

## 16. Contract fixtures, budgets, and release gates

These additional tests close gaps that an attractive UI and successful build cannot demonstrate. The task evidence convention from section 13 applies. Test names below are planned artifacts, not existing tests. PHP reference execution must use an isolated compatible runtime and fixture data; do not boot the real application with production configuration or assume old PHP code runs unchanged under PHP 8.

- [ ] **TEST-01 — Freeze a PHP semantic oracle.** Depends: FND-04. Extract isolated source helper inputs/outputs for URL normalization, wrapper resolution, CRC32, excerpts, entity handling, relative dates, title spacing, and source ordering. Record PHP version, timezone, source hashes, and any harness shims; do not alter expected behavior to make the new implementation pass. Evidence: immutable oracle fixtures with provenance.
- [ ] **TEST-02 — Build feed/HTTP fixture coverage.** Depends: FND-04. Include RSS/Atom/RDF, full versus summary HTML, multilingual dates, declared encodings/BOM, namespace variants, GUID reuse/missing GUID, same-link distinct IDs, xml:base, future/undated entries, 100-entry cap, malformed XML, compression, 304, auth, redirects, timeouts, and private-address denial. Use static fixtures and a controlled HTTP server, with no dependency on live publishers in CI. Evidence: corpus manifest and named scenarios.
- [ ] **TEST-03 — Verify every Fever API combination.** Depends: API-03, API-04. Enumerate read flags, combined flags, JSON/XML, auth failure, selection union and precedence, 50-item boundaries, zero/missing IDs, empty CSV sets, bulk cutoff, Sparks, no-op link saves, favicon encoding, and numeric/time types. Include root and nonroot base paths through the deployed proxy. Evidence: machine-readable request/response matrix.
- [ ] **TEST-04 — Verify Hot intermediate and final states.** Depends: HOT-02, HOT-03, HOT-04. Cover every numbered phase in section 8, including CRC collision reporting, first/repeat penalties, source-query differences, limit-before-threshold, older local representative, title ties, exact window edges, retention, and rounding. Evidence: per-phase expected IDs/scores and rendered/API outputs.
- [ ] **TEST-05 — Verify source-version migration.** Depends: MIG-03, MIG-04. Detect stored Fever version and source table shape. Characterize the legacy `update()` data/default backfills, and implement equivalent staged data transformations for supported older versions without running legacy request-time updates against live data. Unsupported versions fail with a concrete export/upgrade path. Evidence: old/current source schema fixtures.
- [ ] **TEST-06 — Verify migration interruption and conservation.** Depends: MIG-03, MIG-05. Crash/restart every stage, rerun complete imports, reject changed fingerprints and nonempty wrong targets, test key loss, invalid Unicode, duplicate joins, orphan rows, oversized content, and populated starter ID conflicts. Account for every source row and every source field. Evidence: conservation and resume reports.
- [ ] **TEST-07 — Verify authorization and cache isolation.** Depends: AUTH-03, API-06, ING-07. Inventory each modern and legacy alias route with its auth mechanism; test server-rendered data access, POST CSRF, logout, stale sessions, setup races, proxy/CDN caching, media protection, and API failure bodies. Evidence: exhaustive route-access table and assertions.
- [ ] **TEST-08 — Verify worker and mutation races.** Depends: JOB-01, DOM-04, ING-08. Kill a worker before/after commit; expire leases; race two workers; cancel/retry; save during retention; unsubscribe during fetch; change feed URL during fetch; bulk-read while new items arrive; revoke auth during request. Stale work cannot resurrect deleted feeds or overwrite newer state. Evidence: deterministic concurrency tests.
- [ ] **TEST-09 — Establish measurable performance budgets.** Depends: DB-04, DOM-05, HOT-03. Use 200 feeds/20,000 items as a minimum synthetic dataset and a production-sized scrubbed snapshot when available. Initial targets on declared hardware: reader query p95 ≤200ms, Hot p95 ≤500ms, healthy fixture-server refresh of 200 feeds ≤3 minutes at bounded concurrency, and visible local read/save feedback ≤100ms with server confirmation p95 ≤500ms. Record cold/warm results, database size, sample count, resource usage, and network conditions. Revise budgets only with an explained decision before acceptance, never silently after failure. Evidence: benchmark report.
- [ ] **TEST-10 — Verify restore and rollback with new writes.** Depends: OPS-03, OPS-05, MIG-07. Restore into an isolated environment, verify keys/API auth/Hot/state, then roll back a trial that created subscriptions, groups, preference changes, read/save changes, and new content. Reconcile the trial mutation journal without lost activity. Evidence: timed restore and replay results.
- [ ] **TEST-11 — Verify reproducible clean deployment.** Depends: OPS-01, DB-05. Install from the exact lockfile, typecheck, lint, test, build, start web and worker, apply reviewed migrations once, and exercise readiness at the actual base path. Scan source/runtime imports/dependencies for Prisma; historical migration prose may still name it. Evidence: clean-environment build and runtime logs.
- [ ] **TEST-12 — Verify real-client continuity.** Depends: API-05, TEST-03. Test every client the owner currently uses, with at least one actual Fever-compatible client; use a second distinct client if available to catch independent interpretation. Preserve source IDs/cursors and prove initial/incremental sync, read/save, group/Spark behavior, Hot if supported, and deliberate credential rotation. Clearly mark unsupported client features. Evidence: client/version/environment record.

Suggested rollout gates are G0 source/architecture and contracts, G1 Drizzle plus reversible data import, G2 auth/ingestion/Hot/API, G3 full desktop/mobile/integrations, G4 exact-artifact tests and restore rehearsal, G5 authorized cutover, and G6 observed production acceptance. No gate substitutes for missing earlier evidence. Propose a 14-day observation window, configurable before cutover to the actual operating cadence; keep PHP offline/read-only and retain the rollback snapshot throughout it. This is not two active refresh systems. Required signals include daily refresh/backup success, client sync, state conservation, and visible reader errors. Define recovery time and acceptable data-loss window before production, then measure them.


### 16.1 PostgreSQL-specific implementation and acceptance

- [ ] **PG-01 — Pin PostgreSQL schema/runtime conventions.** Depends: FND-03. Select supported PostgreSQL major, pg-core/node-postgres versions, UTF-8, collation/provider, schema namespace, extensions, pool sizes, TLS validation, runtime/migration roles, and explicit target/source configuration. Evidence: accepted environment/type matrix and connection tests.
- [ ] **PG-02 — Implement exact type and sequence conversion.** Depends: DB-01, MIG-03. Test the complete unsigned source range, booleans/enums, epoch seconds/zero, binary and JSON data, ID/FK preservation, sequence reset after commit, empty targets, reruns, and next-ID allocation. Evidence: boundary fixture import and post-import insert assertions.
- [ ] **PG-03 — Prove cross-engine search and order parity.** Depends: DOM-05, DB-04, TEST-01. Compare source MySQL and PostgreSQL results for case/accent/Unicode/wildcard/NULL/tie fixtures, group-title collisions, and URL identity. Resolve every difference without silently losing or merging records. Evidence: collation/query differential report.
- [ ] **PG-04 — Prove PostgreSQL Hot and API numeric parity.** Depends: HOT-03, API-03, TEST-04. Validate aggregate SQL, precision/rounding, threshold phase order, ID ranges, epoch serialization, booleans-to-integers, empty arrays/CSV, and stable ordering. Evidence: PostgreSQL-backed Hot/API golden tests.
- [ ] **PG-05 — Verify PostgreSQL transaction and pool behavior.** Depends: JOB-01, DOM-04, DB-02. Test short queue locks, fences, transaction connection affinity, deadlock/serialization retry, pool exhaustion, graceful shutdown, database restart, and migration-lock behavior under the actual pooler configuration. Evidence: concurrent PostgreSQL integration tests.
- [ ] **PG-06 — Rehearse MySQL-to-PostgreSQL migration.** Depends: MIG-06, PG-02, PG-03, PG-04. Freeze MyISAM writers, extract a consistent source, import into PostgreSQL, reconcile all fields/state, allocate new IDs, and resume a failed run. Keep optional starter SQLite import separately reconciled. Evidence: source and target fingerprints with zero unexplained differences.
- [ ] **PG-07 — Rehearse PostgreSQL backup and recovery.** Depends: OPS-03, PG-01. Restore logical archive and the selected production recovery mechanism into isolation; verify roles/grants/extensions/sequences, encrypted credentials, schema, API auth, and source-equivalent reader state. Measure RPO/RTO and backup-age alerting. Evidence: timed restore/PITR report or an explicitly accepted equivalent meeting RPO.
- [ ] **PG-08 — Rehearse PostgreSQL-to-PHP rollback boundary.** Depends: OPS-05, PG-06, PG-07. Restore retained MySQL snapshot, replay mapped target mutations through the tested reverse path, reconcile new IDs/content/credentials, and verify old PHP/client behavior. No claim that a PostgreSQL dump is usable by PHP. Evidence: rollback-after-new-writes report and explicit unsupported-value dispositions.

## 17. Exhaustive preference mapping

All rows require import preservation, validation, persistence, and a per-key test under DOM-06 and UX-23 unless another task is named. Source: `firewall/app/libs/fever.php:44–117`. Defaults describe the PHP source; imported values take precedence. The default policy for a fresh installation may differ only when recorded in FND-03. Unknown keys remain in the migration archive until classified.

| Key | Source default | Target behavior and evidence |
|---|---|---|
| `use_celsius` | false | Hot display/API unit, HOT-03, UX-14 |
| `refresh_interval` | 15 minutes | Due scheduling, JOB-01, JOB-04 |
| `item_expiration` | 10 weeks | 2/4/6/10-week unsaved retention, ING-08 |
| `new_window` | true | Explicit external-navigation behavior, UX-26 |
| `unread_counts` | false | Global/group/feed inheritance; title/list counts, UX-05, UX-15 |
| `layout` | 0 fixed | Fixed/fluid layout, UX-02 |
| `item_excerpts` | true | Global/group/feed excerpt policy, UX-08 |
| `item_allows` | 1 images | 0 text, 1 text/images, 2 safe-rich adaptation; ING-05, UX-08 |
| `sort_order` | 0 newest | Global/group/feed chronological direction with stable tie order, UX-12 |
| `auto_spark` | false | Manual add, Feedlet, and OPML behavior, DOM-03 |
| `per_page` | 20 | Reader/Hot page size; Fever API items still max 50, DOM-05, HOT-02 |
| `auto_read` | true | Explicit scroll/open behavior and paging, UX-10, UX-11 |
| `mobile_read_on_scroll` | true | 75% source boundary, UX-29 |
| `mobile_read_on_back_out` | true | Rendered-list scope, UX-29 |
| `mobile_view_in_app` | true | Optional embed plus external fallback, UX-32 |
| `auto_reload` | false | Post-refresh UI reload without lost position, JOB-03 |
| `auto_refresh` | 1 browser | Browser enqueue versus operator scheduling; no request timer worker, JOB-04 |
| `auto_update` | 1 | Preserve imported value as legacy metadata; source remote updater already disabled; local release policy under OPS-04 |
| `toggle_click` | 1 | Non-link item click toggle, UX-08 |
| `anonymize` | 0 | Referrer-policy equivalent; no dead vendor redirect, UX-26 |
| `session_timeout` | 6 minutes | New-item reading boundary only, UX-06 |
| `blacklist` | empty string | Preserve ordered raw rules plus safe compiled representation, HOT-04 |
| `share` | false | Saved RSS publication with explicit privacy disposition, INT-03 |
| `services[]` | Email, Delicious, Instapaper, Twitter templates | Preserve ordered `name`, `url`, and `key`; do not assume any old service is still available or silently replace configured destinations, INT-04 |
| `ui.section`, `ui.previous` | 0, 0 | Hot/Kindling/Saved/Sparks/Search plus previous section, UX-03 |
| `ui.group_id`, `ui.feed_id` | 0, 0 | Virtual all scopes and valid selected IDs, UX-03 |
| `ui.search`, `ui.has_focus` | empty, groups | Search/clear/return and focus state, UX-04 |
| `ui.show_feeds`, `ui.show_read` | 1, 1 | Panel and read visibility, UX-02, UX-12 |
| `ui.hot_start`, `ui.hot_range` | 0, 7 days | Exact Hot window selection, UX-14 |

## 18. Selected decisions

| Topic | Direction |
|---|---|
| Database | PostgreSQL with Drizzle and node-postgres. MySQL and SQLite stay within offline source tooling. |
| Refresh | Durable PostgreSQL queue, leases and fenced commits, driven by a supervised worker or authenticated finite Vercel drain. |
| UI | Preserve the interface and original assets with deliberate accessibility and responsive adaptations. |
| Authentication | Credentials-based browser authentication, secure hashes and revocation, plus a separate Fever API credential verifier. |
| Hot | Preserve source phase order, pagination before threshold, representative-item rules, and time windows. |
| Migration | Consistent byte-preserving source snapshots, stable IDs, resumable imports, field reconciliation and explicit rollback after target writes. |
| Tracking | Keep permanent task IDs and separate source compatibility, synthetic tests, deployment validation, and production acceptance. |

## 19. Concrete source coverage crosswalk

The route ledger in section 10 accounts for all 23 route handlers plus dispatcher-only `empty-cache` and `visit`. Its management-action paragraph accounts for all 20 actions. The table below expands the complete 65-template inventory into concrete task/evidence links. Legacy paths are relative to the optional external PHP source root described in section 2. `E-<task ID>` means the evidence record for that task, not an artifact already produced. FND-01 creates the machine-readable version with content hashes; QA-04 checks it against the final source inventory.

| Source template | Implementation and acceptance tasks | Required evidence records |
|---|---|---|
| `firewall/app/views/default/blacklist.php` | HOT-04, UX-25 | E-HOT-04, E-UX-25 |
| `firewall/app/views/default/empty.php` | OPS-06, UX-40 | E-OPS-06, E-UX-40 |
| `firewall/app/views/default/errors.php` | OPS-02, UX-13, UX-18 | E-OPS-02, E-UX-13, E-UX-18 |
| `firewall/app/views/default/extras.php` | JOB-04, INT-02, DOC-01, UX-40 | E-JOB-04, E-INT-02, E-DOC-01, E-UX-40 |
| `firewall/app/views/default/feedlet.php` | INT-02, UX-36 | E-INT-02, E-UX-36 |
| `firewall/app/views/default/feedlet/bookmarklet.php` | INT-02, UX-36 | E-INT-02, E-UX-36 |
| `firewall/app/views/default/feedlet/login.php` | INT-02, UX-36 | E-INT-02, E-UX-36 |
| `firewall/app/views/default/flush.php` | OPS-06, UX-40 | E-OPS-06, E-UX-40 |
| `firewall/app/views/default/install/activation.php` | FND-03, DOC-01, UX-35 | E-FND-03, E-DOC-01, E-UX-35 |
| `firewall/app/views/default/install/configuration.php` | AUTH-05, OPS-01, UX-35 | E-AUTH-05, E-OPS-01, E-UX-35 |
| `firewall/app/views/default/install/database.php` | AUTH-05, OPS-01, UX-35 | E-AUTH-05, E-OPS-01, E-UX-35 |
| `firewall/app/views/default/install/eula.php` | FND-03, DOC-01, UX-35 | E-FND-03, E-DOC-01, E-UX-35 |
| `firewall/app/views/default/install/existing.php` | AUTH-05, OPS-01, UX-35 | E-AUTH-05, E-OPS-01, E-UX-35 |
| `firewall/app/views/default/install/info.php` | AUTH-05, OPS-01, UX-35 | E-AUTH-05, E-OPS-01, E-UX-35 |
| `firewall/app/views/default/keyboard-shortcuts.php` | UI-06, UX-16 | E-UI-06, E-UX-16 |
| `firewall/app/views/default/login.php` | AUTH-01, AUTH-04, UX-34 | E-AUTH-01, E-AUTH-04, E-UX-34 |
| `firewall/app/views/default/manage/add-feed.php` | DOM-01, UX-19 | E-DOM-01, E-UX-19 |
| `firewall/app/views/default/manage/add-group.php` | DOM-02, UX-21 | E-DOM-02, E-UX-21 |
| `firewall/app/views/default/manage/add-to-blacklist.php` | HOT-04, UX-25 | E-HOT-04, E-UX-25 |
| `firewall/app/views/default/manage/auth-feed.php` | ING-02, UX-19 | E-ING-02, E-UX-19 |
| `firewall/app/views/default/manage/delete-feed.php` | DOM-01, UX-20 | E-DOM-01, E-UX-20 |
| `firewall/app/views/default/manage/delete-group.php` | DOM-02, UX-21 | E-DOM-02, E-UX-21 |
| `firewall/app/views/default/manage/delete-sparks.php` | DOM-03, UX-22 | E-DOM-03, E-UX-22 |
| `firewall/app/views/default/manage/display-options-feed.php` | DOM-06, UX-08, UX-23 | E-DOM-06, E-UX-08, E-UX-23 |
| `firewall/app/views/default/manage/display-options-group.php` | DOM-06, UX-08, UX-23 | E-DOM-06, E-UX-08, E-UX-23 |
| `firewall/app/views/default/manage/edit-feed.php` | DOM-01, UX-19 | E-DOM-01, E-UX-19 |
| `firewall/app/views/default/manage/edit-group.php` | DOM-02, UX-21 | E-DOM-02, E-UX-21 |
| `firewall/app/views/default/manage/edit-sparks.php` | DOM-03, UX-22 | E-DOM-03, E-UX-22 |
| `firewall/app/views/default/manage/export.php` | INT-01, UX-38 | E-INT-01, E-UX-38 |
| `firewall/app/views/default/manage/import.php` | INT-01, UX-38 | E-INT-01, E-UX-38 |
| `firewall/app/views/default/manage/preferences.php` | DOM-06, AUTH-02, INT-04, UX-23 | E-DOM-06, E-AUTH-02, E-INT-04, E-UX-23 |
| `firewall/app/views/default/manage/update.php` | OPS-04, UX-40 | E-OPS-04, E-UX-40 |
| `firewall/app/views/default/page/footer.php` | UI-01, UX-34, UX-35, UX-40 | E-UI-01, E-UX-34, E-UX-35, E-UX-40 |
| `firewall/app/views/default/page/header.php` | UI-01, UX-34, UX-35, UX-40 | E-UI-01, E-UX-34, E-UX-35, E-UX-40 |
| `firewall/app/views/default/reader.php` | UI-02, UX-02, UX-24 | E-UI-02, E-UX-02, E-UX-24 |
| `firewall/app/views/default/reader/feeds-alpha.php` | UI-02, UX-03, UX-05, UX-22 | E-UI-02, E-UX-03, E-UX-05, E-UX-22 |
| `firewall/app/views/default/reader/feeds.php` | UI-02, UX-03, UX-05, UX-22 | E-UI-02, E-UX-03, E-UX-05, E-UX-22 |
| `firewall/app/views/default/reader/footer.php` | UI-01, UI-02, UX-01, UX-15 | E-UI-01, E-UI-02, E-UX-01, E-UX-15 |
| `firewall/app/views/default/reader/groups.php` | UI-02, UX-03, UX-05, UX-22 | E-UI-02, E-UX-03, E-UX-05, E-UX-22 |
| `firewall/app/views/default/reader/header.php` | UI-01, UI-02, UX-01, UX-15 | E-UI-01, E-UI-02, E-UX-01, E-UX-15 |
| `firewall/app/views/default/reader/items.php` | UI-04, UX-06, UX-12, UX-11 | E-UI-04, E-UX-06, E-UX-12, E-UX-11 |
| `firewall/app/views/default/reader/js-initial.php` | DOM-06, UI-02, UX-04, TEST-07 | E-DOM-06, E-UI-02, E-UX-04, E-TEST-07 |
| `firewall/app/views/default/reader/js-reload.php` | DOM-06, UI-02, UX-04, TEST-07 | E-DOM-06, E-UI-02, E-UX-04, E-TEST-07 |
| `firewall/app/views/default/reader/links.php` | UI-03, UX-14, UX-31 | E-UI-03, E-UX-14, E-UX-31 |
| `firewall/app/views/default/reader/xhr.php` | DOM-06, UI-02, UX-04, TEST-07 | E-DOM-06, E-UI-02, E-UX-04, E-TEST-07 |
| `firewall/app/views/default/rss.php` | INT-03, UX-39 | E-INT-03, E-UX-39 |
| `firewall/app/views/default/ui.php` | UI-05, UI-06, UX-17, UX-18 | E-UI-05, E-UI-06, E-UX-17, E-UX-18 |
| `firewall/app/views/default/uninstall.php` | OPS-06, UX-40 | E-OPS-06, E-UX-40 |
| `firewall/app/views/default/unorphan.php` | OPS-06, UX-40 | E-OPS-06, E-UX-40 |
| `firewall/app/views/default/updated.php` | OPS-04, UX-40 | E-OPS-04, E-UX-40 |
| `firewall/app/views/mobile/feedlet.php` | INT-02, UX-36 | E-INT-02, E-UX-36 |
| `firewall/app/views/mobile/login.php` | AUTH-01, AUTH-04, UX-34 | E-AUTH-01, E-AUTH-04, E-UX-34 |
| `firewall/app/views/mobile/manifest.php` | UI-07, UX-33 | E-UI-07, E-UX-33 |
| `firewall/app/views/mobile/page/footer.php` | UI-01, UX-34, UX-35, UX-31 | E-UI-01, E-UX-34, E-UX-35, E-UX-31 |
| `firewall/app/views/mobile/page/header.php` | UI-01, UX-34, UX-35, UX-31 | E-UI-01, E-UX-34, E-UX-35, E-UX-31 |
| `firewall/app/views/mobile/reader.php` | UI-02, UX-28, UX-24 | E-UI-02, E-UX-28, E-UX-24 |
| `firewall/app/views/mobile/reader/feeds.php` | UI-02, UX-03, UX-05, UX-28 | E-UI-02, E-UX-03, E-UX-05, E-UX-28 |
| `firewall/app/views/mobile/reader/groups.php` | UI-02, UX-03, UX-05, UX-28 | E-UI-02, E-UX-03, E-UX-05, E-UX-28 |
| `firewall/app/views/mobile/reader/item.php` | UI-07, UX-30 | E-UI-07, E-UX-30 |
| `firewall/app/views/mobile/reader/items.php` | UI-04, UX-06, UX-12, UX-29 | E-UI-04, E-UX-06, E-UX-12, E-UX-29 |
| `firewall/app/views/mobile/reader/js-initial.php` | DOM-06, UI-02, UX-04, TEST-07 | E-DOM-06, E-UI-02, E-UX-04, E-TEST-07 |
| `firewall/app/views/mobile/reader/js-reload.php` | DOM-06, UI-02, UX-04, TEST-07 | E-DOM-06, E-UI-02, E-UX-04, E-TEST-07 |
| `firewall/app/views/mobile/reader/links.php` | UI-03, UX-14, UX-31 | E-UI-03, E-UX-14, E-UX-31 |
| `firewall/app/views/mobile/reader/webview.php` | UI-07, UX-32 | E-UI-07, E-UX-32 |
| `firewall/app/views/mobile/reader/xhr.php` | DOM-06, UI-02, UX-04, TEST-07 | E-DOM-06, E-UI-02, E-UX-04, E-TEST-07 |

No template needs to survive as a separate React file. Internal `xhr`, `js-initial`, and `js-reload` views map to structured data, safe hydration, and state restoration rather than injected executable HTML. Installation activation/update screens map to their effective disabled baseline or modern equivalent; source notices remain covered. The function is the coverage unit.

| Additional owning source | Required task/test coverage |
|---|---|
| `firewall/app/views/default/scripts/reader.js`, `scripts/fever.js` | UI-02–UI-06; UX-03–UX-27; command registry, menus, auto-read, paging, services, and drag states |
| `firewall/app/views/mobile/scripts/iphone.js`, mobile `scripts/fever.js` | UI-07; UX-28–UX-33; rendered-row back-out, scroll threshold, swipe, request ordering, and settings |
| Desktop/mobile `styles/*.css` and their image trees; `firewall/app/images/*` | UI-01, UX-01, UX-02, UX-07, UX-14, UX-27, UX-33; asset hash/reference manifest and state screenshots |
| `firewall/app/data/help.php`, `feedlet.php`, `EULA.txt` | DOC-01, INT-02, UX-18, UX-35, UX-36; help/Feedlet copy and retained notices |
| `firewall/app/libs/omdomdom.php`, `simplepie/simplepie-parse-date.php` | ING-03, TEST-01, TEST-02; XML/encoding/date compatibility |
| `firewall/app/libs/request.php`, `util.php` | ING-01, ING-05–ING-07, HOT-01, TEST-01, TEST-02; safe transport and helper parity |
| `firewall/app/libs/SIDB423.php`, `SIDB5.php` | DB-01–DB-05, PG-01–PG-06; replace legacy database semantics with tested PostgreSQL queries |
| Root `index.php`, `boot.php`, `safety-reboot.php`, `safety-unlace.php` | API-01, OPS-01, OPS-04–OPS-06; root/base-path routing and safe operator equivalents |
| Historical root and starter README/setup/TODO/planning files | FND-02, DOC-01; reconcile stale completion claims and Prisma/MySQL runtime instructions; mark this spec authoritative |

### 19.1 Source-column conservation map

Every source column has a destination or explicit restricted-archive disposition. DB-01 expands the conceptual target names into exact pg-core definitions; MIG-06 verifies field-level digests and transformed equivalents. Source nulls, zeros, and empty strings are distinguished before any conversion. Unrepresentable values are preserved in quarantine and block acceptance until resolved.

| Source table / columns | Destination and invariant |
|---|---|
| `_config.id` | Installation/import provenance; preserve original configuration-row identity |
| `_config.cfg` | Owner credential migration, installation version/timestamps, reading boundary, maintenance/update metadata, and restricted source archive; activation material stays nonexecuting |
| `_config.prefs` | Every key in section 17, ordered services, reader state, and unknown-key archive |
| `feeds.id`, `favicon_id`, `title`, `url`, `site_url`, `domain` | Feed stable IDs and full display/navigation metadata; default favicon sentinel resolved explicitly |
| `feeds.url_checksum` | Legacy unsigned CRC32 plus collision-safe canonical identity; do not drop evidence after canonicalization |
| `feeds.requires_auth`, `auth` | Protected-feed/error status and encrypted feed_credentials; decode Basic payload without logging it |
| `feeds.is_spark`, `prevents_hotlinking` | Spark and media policy flags |
| `feeds.item_excerpts`, `item_allows`, `unread_counts`, `sort_order` | Four per-feed overrides including -1 inherit |
| `feeds.last_refreshed_on_time`, `last_updated_on_time`, `last_added_on_time` | Fetch-state legacy timestamps plus distinct modern attempt/success fields |
| `feeds_groups.feed_id`, `group_id` | Many-to-many relation; duplicate/null/orphan cases reported, never silently discarded |
| `groups.id`, `title`, `item_excerpts`, `item_allows`, `unread_counts`, `sort_order` | Stable group identity/title and four overrides; source duplicate names audited before unique constraints |
| `items.id`, `feed_id`, `uid` | Stable item ID and feed-scoped raw/truncated identity aliases; nullable/duplicate cases quarantined or resolved |
| `items.title`, `author`, `description`, `link` | Full original metadata/raw HTML/link, separately sanitized render content and search text |
| `items.url_checksum` | Original unsigned comparison checksum plus new canonical key |
| `items.read_on_time`, `is_saved`, `created_on_time`, `added_on_time` | Read state/time, saved flag, publication and first-seen seconds; never reset during refresh |
| `links.id`, `feed_id`, `item_id` | Stable occurrence identity and relationships; multiple occurrences per URL remain legal |
| `links.is_blacklisted`, `is_item`, `is_local`, `is_first` | Exact imported ranking flags before reprocessing |
| `links.title`, `url`, `url_checksum`, `title_url_checksum` | Original occurrence text/URL/checksums plus versioned canonical key |
| `links.weight`, `created_on_time` | Ranking weight and source seconds preserved for frozen-clock Hot comparison |
| `favicons.id`, `cache`, `url`, `url_checksum`, `last_cached_on_time` | Stable IDs, validated decoded bytes/MIME, source URL/checksum, and cache time; API representation remains compatible |

## 20. Tracker procedure and 100% exit contract

This checklist preserves all 138 original broad capability and migration acceptance IDs. The task boxes in this document are a reusable review template, not a measurement of current implementation completeness. Copy it into a private deployment ledger and mark only the gates applicable to your installation; record a reason for each non-applicable source or cutover task. A fresh installation does not need a legacy transfer or a PHP rollback.

Use the copied checklist to track your review in a private evidence directory outside the checkout. For each task, assign an owner in an `index.json` ledger, add evidence in a subdirectory named for the task ID, and record the acceptance, source/artifact/schema versions, commands/test names, actual results, environment, date, and reviewer. An optional `blocked_reason` distinguishes waiting from unfinished work. Leave the Markdown box unchecked while blocked or awaiting evidence. Preserve permanent IDs; newly discovered obligations receive new IDs and increase the denominator.

Check a task only when its dependencies, implementation/acceptance obligations, and linked evidence pass. An approved retirement needs an explicit reason, decision pointer, preserved-data disposition, replacement evidence, and reviewer before its task can close. Do not remove difficult tasks, exclude failing tests, or count a proposal as an approved retirement to inflate progress. Evidence for synthetic fixtures, staging, actual clients, and production must remain distinguishable.

Report separate foundation/data/domain/UI/operations/production progress as well as the total. QA-01 waits for every UX, TEST, and PG acceptance task. CUT-02 is an actual authorized production switch, CUT-03 is the observation window, and TRACE-01 closes only after those gates. A local build can finish while production migration remains incomplete.

The final completion ledger must demonstrate:

1. Every required checkbox has evidence, every dependency passes, and all discovered legacy routes/actions/templates/preferences/columns/commands/assets are mapped.
2. PostgreSQL is the sole active target database, Drizzle is the sole active ORM, and runtime Prisma/MySQL/SQLite code and stale setup paths are removed or isolated to documented source import tooling.
3. Source IDs, content, memberships, preferences, read/saved state, timestamps, API clients, and Hot outputs reconcile with no unexplained loss or difference.
4. Desktop/mobile workflows, styles, keyboard operation, accessibility, all management/integration surfaces, and safe adaptations pass their acceptance matrices.
5. Reproducible exact-artifact build/deployment, consistent MyISAM extraction, PostgreSQL restore, and post-write rollback are proven.
6. Actual production-origin browser/client/refresh/backup checks and the observation window pass, with no unresolved blocking product, data, or operational decision.

Read-only progress command for your copied checklist (replace the example path):

```python
from pathlib import Path
import re
text = Path('/absolute/private/migration-review.md').read_text()
tasks = re.findall(r'^- \[([ x])\] \*\*([A-Z]+-\d+) —', text, re.M)
assert len({task_id for _, task_id in tasks}) == len(tasks)
done = sum(mark == 'x' for mark, _ in tasks)
print(f'{done}/{len(tasks)} required tasks complete ({done / len(tasks):.1%})')
```

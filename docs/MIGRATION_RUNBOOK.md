# Legacy migration, rehearsal, cutover, and rollback

This is a procedure for moving an existing Fever installation into PostgreSQL. A fresh installation needs only the [setup instructions](../README.md#setup). Migration tools are included here; the original PHP installation and its MySQL database are optional external sources supplied by the operator. No PHP checkout is required to run the new reader. Select and verify the exact source, target, backups, and authorization for each migration. Use the [migration specification](NEXTJS_MIGRATION_SPEC.md) to track acceptance for your installation; this document makes no claim that your data has already been rehearsed or migrated.

## Prepare a consistent source

Inventory the actual source host, MySQL version, table prefix, character set/collation, table engines, source version, database size, backup location, and all writers. Do not read or execute PHP configuration files to discover credentials. Supply an explicitly authorized read-only source URL through a private operator env file. The default legacy prefix is often `fever_`; the configuration table then has two underscores, `fever__config`.

The effective source creates MyISAM tables. `--single-transaction` alone does not freeze MyISAM. Disable PHP web/API writes, in-browser refresh, scheduled refresh, and maintenance; verify the freeze externally, then record its UTC time and evidence reference. Alternatively, use a separately reviewed consistent read-lock procedure. The extractor does not take intrusive source locks or execute source SQL dumps. It issues metadata and SELECT statements through a read-only session, while consistency relies on the explicit external freeze.

The timestamps in the commands below are examples: replace them with the actual verified freeze times. Create a private mode `0700` evidence directory on encrypted storage before extraction. Every output is an explicit absolute path, exclusive-created mode `0600`; files are never overwritten. The neutral NDJSON format has a versioned header, exact byte-preserving base64 cells, explicit NULLs, table descriptors, row ordinals, per-table/per-field hashes, maximum IDs, and a final source fingerprint. Raw SQL, PHP, HTML, object serialization, and reference payloads are never executed. PHP string lengths are read as byte lengths before UTF-8 conversion.

```sh
pnpm run import:legacy -- extract-mysql --env-file /etc/fever/operator.env --source-url-env LEGACY_MYSQL_URL --prefix fever_ --frozen-at 2026-10-23T12:00:00Z --freeze-evidence /srv/fever/evidence/source-freeze.txt --output /srv/fever/evidence/source.ndjson
pnpm run import:legacy -- dry-run --snapshot /srv/fever/evidence/source.ndjson --report /srv/fever/evidence/dry-run.json
```

The freeze evidence string is an operator assertion and reference; the tool cannot prove that an external PHP process was stopped. Inspect and retain the real source-host evidence. Snapshot fingerprints include metadata and freeze time, so a re-extraction is a new fingerprint even if the table bytes happen to match. Reuse the exact frozen file for an interrupted import.

The bounded decoder accepts null, booleans, finite numbers, strings, and ordered PHP arrays. It rejects objects, custom serializers, references, duplicate array keys, unsafe numbers, extra bytes, malformed base64, and excessive length/depth/entry counts. Snapshot parsing limits individual lines and total rows. Exact original bytes remain in the neutral archive; invalid UTF-8, NUL text, invalid flags, unrepresentable dates, orphan references, duplicate IDs/UIDs, URL identity collisions, and unsupported favicon formats become redacted issues with intact restricted source rows.

Stored Fever versions 125–139 with the current table shape are supported. The source changes in that interval do not require historical data rewrites. Earlier versions require a separately reviewed data-only schema converter or an externally managed, isolated source upgrade and fresh export; this tool does not invoke legacy `update()` or run imported SQL/PHP. Missing columns fail into explicit quarantine. No production source upgrade is implied.

Review the dry-run's source counts, imported/quarantined/duplicate-membership conservation, every source field digest/disposition, owner, preferences, services, read/unread/saved totals, and issues. Duplicate relationships are counted and archived before coalescing. Other ambiguous rows are not silently merged. Full original rows are also encrypted into the target's migration archive, so NULL distinctions, credentials, unknown fields, and serialized unknown keys survive conversion. Unknown fields remain archived until classified.

## Import into an isolated PostgreSQL target

Provision a separate empty target with the reviewed schema and keys using the [operations guide](OPERATIONS.md). Inspect its fingerprint. Import takes an explicit source fingerprint, target fingerprint, target URL variable, canonical base URL, and confirmation. The target must be empty or belong to the same import; starter and legacy namespaces cannot be silently merged.

```sh
pnpm run import:legacy -- inspect-target --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL
pnpm run import:legacy -- apply --env-file /etc/fever/operator.env --snapshot /srv/fever/evidence/source.ndjson --source-fingerprint SOURCE_SHA256 --report /srv/fever/evidence/apply-plan.json --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256 --base-url https://reader.example.com --saved-rss-policy legacy --confirm import:TARGET_SHA256
```

Choose Saved RSS deliberately if the source publishes saved items. `--saved-rss-policy legacy` preserves publication of protected-feed items; `exclude-protected` is an explicit privacy adaptation. The importer requires a choice for an enabled source feed. Unsupported sharing destinations remain preserved and visibly disabled; safe `#http(s)` services retain background transport. Original email/password bytes derive the existing API digest before only its verifier is persisted; the browser password is independently scrypt-hashed. Feed Basic credentials are split once at the first colon and encrypted with record-bound authenticated encryption. Do not trim passwords or replace the legacy API digest with a new random value during import.

Default apply refuses blocking source issues. After reviewing exact row dispositions, `--quarantine-confirm SOURCE_SHA256` permits the accepted rows to import while preserving the full rejected rows in encrypted quarantine. This is not permission to erase them, claim parity, or activate. Every quarantine row needs an explicit resolution/disposition before the cutover evidence can be approved. If the owner configuration itself is unimportable, apply stops.

Import stages are configuration/owner, groups, favicons, feeds and credentials/fetch state, memberships, items and UID aliases, and link occurrences. Source IDs and source epoch seconds, including zero and unsigned values, are preserved. Item HTML is retained raw and separately sanitized. Occurrence flags/weights are imported without re-extraction. Every inserted field is read back, then a final whole-import comparison verifies accepted mapped fields, source-archive counts, reading state, and relationships. Original field digests remain available independently of derived HTML differences.

Batches commit entity writes, encrypted row archives, and checkpoints together. A retry uses a new report filename and the exact same snapshot, fingerprints, URL, key map, policy, and base URL. Completed source rows are skipped; an already completed run does not overwrite post-import state. Resume rejects changed source, another target run, schema/policy changes, or a lost/mismatched encryption key. Identity sequences reconcile above both existing sequence state and source maxima, including quarantined IDs, so new records cannot steal a reserved source identity. Empty tables retain their valid first sequence value, and sequence gaps are harmless.

The importer analyzes PostgreSQL tables and leaves the installation in maintenance. Counts and field comparisons are implementation checks, not a completed MySQL/PostgreSQL behavioral proof. Before activation, compare source and target API pages/IDs, complete state sets, preference inheritance, search/collation fixtures, every relevant content digest, and frozen-clock Hot results. Preserve the exact source snapshot/time and separate sanitizer-policy differences from ranking differences.

## Optional SQLite starter

The starter database is read through `better-sqlite3` with `readonly`, `query_only`, and a read transaction; no generated ORM client is required. Provide a clean frozen SQLite database, preserving its WAL/shm files or making a database-consistent copy externally. Do not assume copying only the main file while a writer is active captures its committed state.

```sh
pnpm run import:legacy -- extract-sqlite --source-path /srv/fever/evidence/starter.db --frozen-at 2026-10-23T12:00:00Z --freeze-evidence /srv/fever/evidence/starter-freeze.txt --output /srv/fever/evidence/starter.ndjson
pnpm run import:legacy -- dry-run --snapshot /srv/fever/evidence/starter.ndjson --report /srv/fever/evidence/starter-plan.json
```

Use a separate empty PostgreSQL destination for starter apply, preserving IDs within that namespace. The supported singleton owner is ID 1; another/multiple owner IDs, null ownership, or invalid relationships require an explicit reconciliation. The starter has no saved state, GUID, author, link-occurrence history, or legacy preferences. The report identifies defaults and derived values: `read=true` becomes the documented sentinel epoch 1, absent saved state defaults false, and item identity is `starter:<original-id>`. Source `content` is preserved exactly; no full article is fabricated from a snippet. Millisecond timestamps that would lose precision are quarantined. A populated legacy/starter merge is deliberately refused until a separate namespace/ownership reconciliation is reviewed.

## Rehearsal and concrete cutover

Perform a full isolated rehearsal from the protected final-shape source archive. Time extraction, import, reconciliation, PostgreSQL backup/restore, browser/client tests, a new refresh, and rollback after representative writes. Exercise interruption before/after each stage and inside batches, full rerun, key loss, invalid encoding, duplicates/orphans, failed migration, and failed restore. Do not characterize authored checks as passing results. Capture artifact, schema, source/target fingerprints, environment, exact commands, measured results, and reviewer in the evidence ledger.

Prepare the production switch only after the applicable [specification gates](NEXTJS_MIGRATION_SPEC.md) pass. The review package must identify the exact artifacts, source freeze actions, public origin/base path, selected Saved RSS policy, scheduler/worker supervision, backup/key locations, restoration access, rollback duration, accepted source issues, RPO/RTO, and observation window. At the authorized final switch, freeze all PHP writers, take the consistent final source archive, import/reconcile into the exact target, verify the target while isolated, switch the existing origin/path, activate with reviewed evidence, and enable one worker. Verify login, actual Fever clients, RSS policy, reader state mutations, refresh, diagnostics, and backup at the production origin. Keep old PHP and MySQL offline/read-only throughout observation.

## Rollback after target writes

The rollback tooling maps the frozen final target state into a MySQL-neutral snapshot and preserves the complete post-import mutation journal and encrypted maintenance snapshots as an activity audit. It does not assume every journal entry is a full entity: reader-state events can be partial, while auth events intentionally omit secrets. The final-state conversion includes additions, updates, deletions, subscriptions, memberships, preferences, new content, source IDs, read/saved changes, and occurrence rows. Quarantined original source rows remain in the reverse image unchanged. Reverse conversion preserves unknown original fields and fails if a newly created row needs an unknown required column.

First quiesce PostgreSQL writes, stop the worker, and take a complete current PostgreSQL backup plus keys. Keep the retained final MySQL baseline and old exact PHP artifact. The reverse command requires the same baseline fingerprint as a completed import:

```sh
pnpm run ops -- rollback-export --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256 --baseline /srv/fever/evidence/source.ndjson --output /srv/fever/evidence/rollback-final.ndjson --confirm rollback-export:TARGET_SHA256
```

This creates a neutral final snapshot, `.manifest.json`, and `.activity.json`, all restricted files. Review them without publishing source content or credentials. The current password must still match the retained original credential. After an account-password/recovery change, provide `--password-file /absolute/private/current-password` containing its exact UTF-8 bytes with no extra newline; the exporter verifies it against both the current browser hash and active API verifier. Secure password hashes cannot reconstruct plaintext. If no valid password is available, use an explicitly approved credential reset/reconciliation before rollback. Auth events are retained as evidence; they are never silently treated as replayable passwords.

The exporter refuses target values outside the old unsigned32 range, varchar255/TEXT capacities, unresolved required source fields, and other unrepresentable state. PHP cannot enforce target RSS exclusion of protected feeds: when relevant, explicitly add `--disable-saved-rss confirmed`, or resolve the policy before export. A truncation, discarded activity, or incompatible credential is never an automatic fallback. The bounded reverse review path currently limits retained source and activity material to 512MiB each; larger datasets need a reviewed partitioned replay before this rollback path is available.

Restore the original MySQL backup into an isolated rollback database using the actual host's verified MySQL restore procedure. This is separate from PostgreSQL restore. The tools never execute an imported SQL dump. Inspect the explicit restored MySQL destination, then apply only the reviewed final snapshot and manifest with separate rollback-writer credentials:

```sh
pnpm run ops -- inspect-mysql --env-file /etc/fever/operator.env --target-url-env ROLLBACK_MYSQL_URL --prefix fever_ --frozen-at 2026-10-23T14:00:00Z --freeze-evidence /srv/fever/evidence/rollback-freeze.txt
pnpm run ops -- rollback-apply --env-file /etc/fever/operator.env --target-url-env ROLLBACK_MYSQL_URL --target-fingerprint MYSQL_TARGET_SHA256 --prefix fever_ --baseline /srv/fever/evidence/source.ndjson --replay /srv/fever/evidence/rollback-final.ndjson --replay-manifest /srv/fever/evidence/rollback-final.ndjson.manifest.json --frozen-at 2026-10-23T14:00:00Z --freeze-evidence /srv/fever/evidence/rollback-freeze.txt --confirm rollback:MYSQL_TARGET_SHA256
```

Replay SQL has fixed validated identifiers and bound values. It compares every existing target row with either the frozen baseline or the final image before writes, checks conflicts/legacy uniqueness, applies idempotent updates/inserts/deletions, replaces explicit relationship pairs, and compares complete final field digests. MyISAM cannot provide transactional rollback: keep a pristine backup, retain failed output/evidence, keep both applications stopped, and resume the same reviewed snapshots after resolving the cause. Never reset to the old snapshot and enable PHP before replay verification. New auto-increment allocations, legacy API authentication, source Hot behavior, and actual clients still require the rehearsed final verification before routing back to PHP.

The reverse exporter is a compatibility conversion with explicit failure boundaries, not proof that every future feature/value will fit PHP. Record unsupported-value dispositions, credential changes, and the actual rehearsal result before declaring the rollback window usable. When observation and acceptance finish, PostgreSQL becomes the only active datastore. Retain offline source/rollback artifacts until a separately authorized retention action.

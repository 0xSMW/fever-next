# Fever operator guide

Use this guide to deploy and maintain your own installation. Start with the [setup instructions](../README.md#setup); use the [migration runbook](MIGRATION_RUNBOOK.md) when moving data from an existing Fever installation. Deployment and migration acceptance criteria are in the [migration specification](NEXTJS_MIGRATION_SPEC.md). Commands below run from the repository root and use example paths and placeholders.

## Release and environment

The runtime is PostgreSQL, a Next.js web process, and a separately supervised worker. MySQL and SQLite drivers belong to the offline migration tools. Web and worker modules must never import `lib/migration/sources.ts`, `lib/migration/rollback.ts`, or CLI modules. There is no request-time schema upgrade, public cron endpoint, PHP interpreter, vendor updater, or automatic filesystem removal.

Use Node.js 24.22.1, pnpm 11.25.0, PostgreSQL 18 with UTF-8, the exact `package.json`/lockfile, and the reviewed [SQL manifest](../migrations/manifest.json). Application sessions use UTC. The [Dockerfile](../Dockerfile) requires an explicit immutable Node 24 Debian image, and [Compose](../deployment/compose.yml) requires immutable web, worker, and PostgreSQL images. These deployment templates need validation on your host; choose roles, image digests, sizing, recovery policy, TLS, and collation deliberately.

Build the web and worker targets from the same source revision, lockfile, Node image, and build arguments. Record both artifact digests and the schema manifest digest. Promote these exact images after rehearsal. Do not rebuild while promoting to production. Build `NEXT_PUBLIC_BASE_PATH` into the artifact: root uses an empty value; `/fever` uses `/fever`. Set `FEVER_BASE_URL=https://reader.example.com/fever`, `NEXTAUTH_URL=https://reader.example.com/fever/api/auth`, and `NEXT_PUBLIC_BASE_PATH=/fever` together. Changing a compiled base path requires a new artifact.

Keep runtime, migration, source-reader, and rollback-writer credentials separate. `deployment/provision-roles.sql` is an administrator-reviewed template for a database named `fever`. The runtime role gets table DML and sequence use, and no schema creation permission. Migrations run as the migration role. Review default privileges, and reapply grants after a restore because archives omit ownership and privileges. Never put passwords in CLI arguments or tracked files.

Use `.env.example` for runtime names and `deployment/operator.env.example` for CLI names. Production operator files must be outside the checkout, mode `0600`, beneath a mode `0700` directory. The CLI accepts only an explicitly provided `--env-file /absolute/path`; it never searches for `.env`, expands shell syntax, or executes file content. Conflicting already-exported values fail closed. CLI commands explicitly select the target variable with `--target-url-env MIGRATION_DATABASE_URL`. A source URL never implies a destination. Examples below run from the repository root and use literal placeholders that must be replaced with inspected fingerprints.

```sh
pnpm run ops -- inspect-target --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL
pnpm run db:migrate -- status --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256
pnpm run db:migrate -- apply --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256 --confirm migrate:TARGET_SHA256
```

The package scripts invoke `node --conditions=react-server --import tsx`. This condition is necessary for server-only module boundaries in standalone tools. PostgreSQL locks require a direct connection or session pooling; transaction-pooling endpoints are unsuitable for the operator's session advisory lock. The fingerprint covers endpoint, database OID, schema OID, server version, encoding, and collation. Reinspect after restore, host changes, or upgrades; never copy an old fingerprint blindly.

The migration runner validates every SQL checksum and the complete applied history, obtains a dedicated-connection advisory lock, then applies one transaction per reviewed version. A failed transaction rolls back its DDL and journal entry. Keep the failed release inactive, inspect the SQL and database state, and rerun the same reviewed release after correcting the operational cause. Editing already-applied SQL is prohibited; add a new version instead. Do not use schema push.

## Supervision, installation, and scheduling

The Compose file publishes only the web process to loopback; PostgreSQL has no host port. Its PostgreSQL 18 data volume mounts at `/var/lib/postgresql`, matching the official image's versioned data-directory layout. An existing TLS proxy can use `deployment/Caddyfile.example`, preserving the entire path and query string. Adapt the proxy and secrets to the actual host before running anything. The scaffold makes the worker an explicit profile so imports and rehearsals cannot accidentally start refresh or retention.

For a fresh installation, provision roles, apply reviewed migrations, start the web image with an independent setup token and keys, and complete the token-gated setup form. Importing an existing installation uses the migration runbook instead. Remove the bootstrap token from runtime configuration after successful initialization. Legacy browser cookies are not carried over.

After acceptance and explicit activation, supervise one worker service. Its PostgreSQL queue is durable; the web process does not own timers. A local operator can enqueue refresh with the runtime environment without putting secrets in argv:

```sh
node --env-file=/etc/fever/runtime.env --conditions=react-server --import tsx scripts/fetchFeeds.ts
node --env-file=/etc/fever/runtime.env --conditions=react-server --import tsx scripts/fetchFeeds.ts --feed 123 --force
node --env-file=/etc/fever/runtime.env --conditions=react-server --import tsx worker/index.ts
```

Use the host's existing supervisor or scheduler for the first command if browser-independent enqueueing is needed. Do not run an overlapping interval script or reuse the old anonymous PHP cron URL. Keep `FEVER_RETENTION_ENABLED=false` through import and first parity validation; enable it only after retention acceptance. A worker failure must not make a completed import disappear.

`GET <base>/api/health` is minimal public readiness. Owner diagnostics include schema/DB health, durable worker heartbeat, backlog, feed failures, and redacted operator-backup metadata. Liveness of a process is separate from a remote feed outage. Alert on worker lease/heartbeat age, sustained queue growth, repeated parse/fetch failures, database connection exhaustion, backup age, and failed restores. The deployment environment must supply alert delivery and agreed thresholds; no unconfigured email or external monitoring account is assumed.

## Freeze and activation

Quiesce serializes against application writes with the shared installation advisory lock, marks the installation as maintenance, cancels active queued jobs, and increments lease fences. Stop worker supervision after this command. In-flight worker commits must fail their status/fence check.

```sh
pnpm run ops -- quiesce --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256 --confirm quiesce:TARGET_SHA256
pnpm run ops -- status --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256
```

Activation requires a private JSON evidence file with `approved: true`, `rehearsalPassed: true`, `targetFingerprint`, `sourceFingerprint` for imported data, `schemaVersion: 2`, the exact `artifactDigest` as 64 hexadecimal characters, and `acceptedIssueIds` as an array of migration issue ID strings. Every quarantined row and every archived row with a reported warning needs a reviewed disposition. `status` returns redacted issue IDs; follow its `nextIssueAfter` cursor with `--issue-after ID` when more than 1,000 entries exist. The evidence must identify real acceptance results and explicit source-quarantine dispositions. These fields do not generate evidence or waive the specification's test gates. An imported source remains in maintenance until activated.

```sh
pnpm run ops -- activate --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256 --evidence /srv/fever/evidence/activation.json --confirm activate:TARGET_SHA256
```

## Backup, restore, and keys

OPML is a subscription interchange format. It omits items, read/saved state, preferences, Hot occurrences, API credentials, encrypted feed secrets, source archives, and journals. Use a complete PostgreSQL custom archive, plus separately recoverable encryption/authentication keys, release artifacts, proxy/TLS state, and any deployment-specific external assets. Database favicon/media records are included; immutable public assets are part of the exact release artifact.

The `backup` command uses `pg_dump` with the same PostgreSQL major as the server, creates an exclusive mode `0600` archive, fsyncs it, computes SHA-256, writes `<archive>.manifest.json`, and only then records redacted backup freshness in `installation.migration_provenance.operatorBackup`. It supplies credentials through child-process environment variables, never a connection-string argument, and never logs dump stderr content. A failed or interrupted output remains visibly incomplete and is never overwritten by a retry; choose a new filename.

```sh
pnpm run ops -- backup --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256 --output /srv/fever/backups/2026-10-23.dump --confirm backup:TARGET_SHA256
pnpm run ops -- export-keys --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256 --output /srv/fever-key-recovery/2026-10-23.json --confirm export-keys:TARGET_SHA256
```

The key recovery file intentionally contains key material. Keep it on separately encrypted, restricted, offline storage; do not put it alongside the database archive, send it to logs, or store it in the repository. Retain every old key ID while any feed credential, migration row, or maintenance archive uses it. Rotation uses a new key ID while keeping the old key map available; do not overwrite the old value under an existing ID. A key backup is not proven until restoration/decryption succeeds on an isolated copy. Authentication-secret loss invalidates browser sessions and recovery-token verifiers; feed-key loss makes encrypted credentials and restricted archives unrecoverable.

Use an empty, separately provisioned PostgreSQL destination for restore. Inspect that destination's fingerprint first. `pg_restore --single-transaction --exit-on-error` restores only the explicitly selected archive with the explicitly approved digest. The tool never runs `--clean`, creates a database, or overwrites a populated target. Restore records its own fingerprint and leaves the installation in maintenance. Restore the original key map and auth secret to a private runtime/operator environment, reapply roles and grants, inspect schema and sequences, and verify credentials, content, state, API clients, and Hot before activation.

```sh
pnpm run ops -- restore --env-file /etc/fever/restore.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint RESTORE_TARGET_SHA256 --archive /srv/fever/backups/2026-10-23.dump --archive-manifest /srv/fever/backups/2026-10-23.dump.manifest.json --archive-sha256 ARCHIVE_SHA256 --confirm restore:RESTORE_TARGET_SHA256
pnpm run ops -- check-keys --env-file /etc/fever/restore.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint RESTORE_TARGET_SHA256 --confirm check-keys:RESTORE_TARGET_SHA256
pnpm run ops -- reconcile-sequences --env-file /etc/fever/restore.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint RESTORE_TARGET_SHA256 --confirm reconcile-sequences:RESTORE_TARGET_SHA256
```

For remote PostgreSQL TLS, use `FEVER_DB_SSL=true`, a verified CA configuration, and `FEVER_PG_SSL_ROOT_CERT` for the libpq client tools if a custom CA is needed. A local trusted container network can explicitly use `FEVER_DB_SSL=false`. Never disable verification merely to get a remote restore through.

Define production RPO, RTO, retention, encrypted off-host copies, capacity alerts, and a measured restore schedule with the actual operator before cutover. Periodic dumps alone do not establish an acceptable recovery window. Select and rehearse PostgreSQL continuous archiving/PITR or explicitly accept the measured logical-backup loss window. This repository does not provision a backup provider or pretend that an untested dump is a recovery proof.

## Recovery, failures, and removal

On a ready installation, the operator may issue a short-lived owner reset token. Output contains the newly issued token once and a recovery URL fragment; keep it out of shell capture and logs. Issuing a new token invalidates older outstanding tokens. The default lifetime is 15 minutes; `--minutes` accepts 1–30. This does not reveal the current password. If the installation is in maintenance, first complete the necessary restore/activation checks because recovery is deliberately unavailable while writes are frozen.

```sh
pnpm run ops -- recover-owner --env-file /etc/fever/operator.env --target-url-env MIGRATION_DATABASE_URL --target-fingerprint TARGET_SHA256 --confirm recover-owner:TARGET_SHA256
```

Expired jobs are reclaimed by bounded worker leases. For a stuck or suspect deployment, quiesce, stop the old worker, inspect diagnostics, correct the cause, and activate the reviewed artifact before enqueueing a new refresh. Never manually decrement fences or clear completed item state. Feed authentication is managed in the protected feed dialog; passwords stay blank in read responses. Private-origin feeds require exact configured origins and a reviewed trust decision. Favicon failures and remote feed failures are isolated from application readiness.

Empty, flush, orphan cleanup, and uninstall use protected preview/confirmation flows and encrypted maintenance backups. Preview counts and saved-item consequences must be reviewed. Operator removal means stopping the explicitly selected deployment and retaining its database volume, backups, keys, source snapshot, and artifact while the rollback window applies. No tool in this lane recursively removes application paths or deletes backup directories. A later retention or volume-removal action requires its own explicit target and authorization.

Post-write rollback to PHP is documented in the [migration runbook](MIGRATION_RUNBOOK.md). A PostgreSQL dump cannot boot PHP. Restoring the old MySQL snapshot without replay discards activity performed after cutover.


## Vercel scheduling

For Vercel, configure the repository root as the project Root Directory and supply the runtime environment variables from [.env.example](../.env.example). Use the installation's canonical HTTPS origin for `FEVER_BASE_URL` and that origin plus `/api/auth` for `NEXTAUTH_URL`. Add a strong independent `CRON_SECRET`, and apply schema migrations separately before serving the release. Deployment never applies DDL.

[vercel.json](../vercel.json) schedules `GET /api/internal/refresh` once per minute. Vercel supplies `Authorization: Bearer CRON_SECRET`; missing or wrong authorization fails before database access. Each invocation drains finite work with a 210-second budget and a 300-second function limit. A dedicated PostgreSQL session advisory lock serializes invocations; job/feed leases, fences, cancellation, and retries remain authoritative. No worker daemon runs on Vercel.

Use a direct or session-preserving database URL and `FEVER_DB_POOL_MAX` of at least 2. Known Neon `-pooler` endpoints and a one-connection pool are rejected. Other transaction poolers also require a session-preserving alternative. A provider termination or database outage can interrupt cleanup, so lease recovery remains necessary. Keep deployment access protection compatible with any external Fever clients that must reach your installation.

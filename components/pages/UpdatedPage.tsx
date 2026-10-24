"use client";

import { appHref } from "@/lib/client/api";
import { PageShell } from "./PageShell";
import type { ReleaseInfo } from "./release.server";

function date(value: number | string | null): string | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
}

export function UpdatedPage({ release }: { release: ReleaseInfo }) {
  const behind = release.databaseSchema !== null && release.databaseSchema < release.expectedSchema;
  const ahead = release.databaseSchema !== null && release.databaseSchema > release.expectedSchema;
  return (
    <PageShell title="While you were out" subtitle={`Fever is running version ${release.appVersion}.`} nav>
      {release.error ? (
        <div className="fp-notice fp-error" role="alert"><p><strong>Status unavailable.</strong> {release.error}</p></div>
      ) : null}
      {behind ? (
        <div className="fp-notice fp-warning" role="status">
          <p><strong>Database update pending.</strong> This release expects database schema {release.expectedSchema}, but the database is at {release.databaseSchema}. The operator needs to run this release&rsquo;s migration before Fever is used.</p>
        </div>
      ) : null}
      {ahead ? (
        <div className="fp-notice fp-warning" role="status">
          <p><strong>Older release running.</strong> The database was upgraded to schema {release.databaseSchema} by a newer release than this one ({release.expectedSchema}). Ask the operator to deploy the matching release.</p>
        </div>
      ) : null}
      <dl className="fp-kv">
        <dt>Release</dt><dd>{release.appVersion}</dd>
        <dt>Database schema</dt>
        <dd>{release.databaseSchema ?? "unknown"}{release.databaseSchema === release.expectedSchema ? " (current)" : ""}</dd>
        {release.status ? <><dt>Installation</dt><dd>{release.status}</dd></> : null}
        {date(release.installedAt) ? <><dt>Installed</dt><dd>{date(release.installedAt)}</dd></> : null}
        {date(release.updatedAt) ? <><dt>Last changed</dt><dd>{date(release.updatedAt)}</dd></> : null}
      </dl>
      <p className="fp-text">
        Fever no longer checks a remote server for updates. Releases are installed by the operator, and the notes for
        each release ship with it. See <a href={appHref("/diagnostics")}>Diagnostics</a> for worker and feed health.
      </p>
      <div className="fp-actions">
        <a className="fp-btn fp-default" href={appHref("/")}>Okay</a>
      </div>
    </PageShell>
  );
}

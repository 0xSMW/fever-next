"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiGet, appHref, command } from "@/lib/client/api";
import { describeError, isSessionError, type DescribedError } from "@/lib/client/errors";
import { PageShell } from "./PageShell";
import { SessionGate } from "./SessionGate";
import { ErrorNotice, Loading, Notice } from "./Status";

type Diagnostics = Record<string, unknown>;
type Row = Record<string, unknown>;

const AUTO_REFRESH_MS = 30_000;
const MAX_ROWS = 500;
const MAX_COLUMNS = 9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function humanize(key: string): string {
  const words = key.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

const TIME_KEY = /(At|_at|Time|_time|On|_on)$/;
const BAD_STATUS = /^(error|failed|failing|fail|down|unhealthy|stalled|unavailable|degraded|auth[_-]?required|unauthorized|timeout|invalid)$/i;
const GOOD_STATUS = /^(ok|ready|healthy|up|running|idle|completed|success|connected)$/i;

function formatTime(value: number | string): string | null {
  let date: Date | null = null;
  if (typeof value === "number" && value > 946_684_800 && value < 10_000_000_000) date = new Date(value * 1000);
  else if (typeof value === "number" && value > 946_684_800_000 && value < 10_000_000_000_000) date = new Date(value);
  else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) date = new Date(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const relative = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86_400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86_400)}d`;
  return `${date.toLocaleString()} (${seconds >= 0 ? `${relative} ago` : `in ${relative}`})`;
}

function Scalar({ name, value }: { name: string; value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="fp-muted">—</span>;
  if (typeof value === "boolean") {
    const good = /error|fail|stale|stalled|blocked/i.test(name) ? !value : value;
    return <span className={good ? "fp-status-ok" : "fp-status-bad"}>{value ? "yes" : "no"}</span>;
  }
  if ((typeof value === "number" || typeof value === "string") && TIME_KEY.test(name)) {
    if (value === 0) return <span className="fp-muted">never</span>;
    const time = formatTime(value);
    if (time) return <>{time}</>;
  }
  if (typeof value === "number") return <>{value.toLocaleString()}</>;
  if (typeof value === "string") {
    if (/status|state|health/i.test(name) && BAD_STATUS.test(value)) return <span className="fp-status-bad">{value}</span>;
    if (/status|state|health/i.test(name) && GOOD_STATUS.test(value)) return <span className="fp-status-ok">{value}</span>;
    if (/error/i.test(name)) return <span className="fp-status-bad fp-break">{value}</span>;
    return <span className="fp-break">{value}</span>;
  }
  return <code className="fp-break">{JSON.stringify(value)}</code>;
}

function KeyValues({ value, depth = 0 }: { value: Record<string, unknown>; depth?: number }) {
  const entries = Object.entries(value);
  if (!entries.length) return <span className="fp-muted">none</span>;
  return (
    <dl className="fp-kv">
      {entries.map(([key, entry]) => (
        <Entry key={key} name={key} value={entry} depth={depth} />
      ))}
    </dl>
  );
}

function Entry({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  let body: ReactNode;
  if (isRecord(value) && depth < 3) body = <KeyValues value={value} depth={depth + 1} />;
  else if (Array.isArray(value) && value.every((entry) => !isRecord(entry) && !Array.isArray(entry))) {
    body = value.length ? <span className="fp-break">{value.map(String).join(", ")}</span> : <span className="fp-muted">none</span>;
  } else if (Array.isArray(value)) body = <span>{value.length.toLocaleString()} entries</span>;
  else body = <Scalar name={name} value={value} />;
  return (
    <>
      <dt>{humanize(name)}</dt>
      <dd>{body}</dd>
    </>
  );
}

function rowHasProblem(row: Row): boolean {
  return Object.entries(row).some(([key, value]) =>
    (/error/i.test(key) && typeof value === "string" && value !== "") ||
    (/status|state|health/i.test(key) && typeof value === "string" && BAD_STATUS.test(value)) ||
    (/requiresAuth|needsAuth|stale|stalled/i.test(key) && value === true));
}

type RetryState = Record<number, "pending" | "queued" | string>;

function RowsTable({ name, rows, feedRows }: { name: string; rows: Row[]; feedRows: boolean }) {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [retry, setRetry] = useState<RetryState>({});
  const problems = rows.filter(rowHasProblem);
  const shown = (problemsOnly ? problems : rows).slice(0, MAX_ROWS);
  const columns: string[] = [];
  for (const row of rows.slice(0, 50)) {
    for (const key of Object.keys(row)) if (!columns.includes(key) && columns.length < MAX_COLUMNS) columns.push(key);
  }

  async function retryFeed(id: number) {
    setRetry((current) => ({ ...current, [id]: "pending" }));
    try {
      await command("refresh.start", { scope: "feed", id, force: true });
      setRetry((current) => ({ ...current, [id]: "queued" }));
    } catch (error) {
      setRetry((current) => ({ ...current, [id]: describeError(error, "Refresh could not be queued.").message }));
    }
  }

  return (
    <>
      <p className="fp-small">
        {rows.length.toLocaleString()} {rows.length === 1 ? "entry" : "entries"}
        {problems.length ? `, ${problems.length.toLocaleString()} with problems` : ", none with problems"}.
        {problems.length ? (
          <label className="fp-choice" style={{ marginLeft: "0.75rem" }}>
            <input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} />
            only show problems
          </label>
        ) : null}
      </p>
      <div className="fp-table-wrap" role="region" aria-label={humanize(name)} tabIndex={0}>
        <table className="fp-table">
          <thead>
            <tr>
              {columns.map((column) => <th key={column} scope="col">{humanize(column)}</th>)}
              {feedRows ? <th scope="col"><span className="fp-sr-only">Actions</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => {
              const id = typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > 0 ? row.id : null;
              const state = id !== null ? retry[id] : undefined;
              return (
                <tr key={id ?? index}>
                  {columns.map((column) => (
                    <td key={column}>{isRecord(row[column]) || Array.isArray(row[column])
                      ? <code className="fp-break">{JSON.stringify(row[column])}</code>
                      : <Scalar name={column} value={row[column]} />}</td>
                  ))}
                  {feedRows ? (
                    <td>
                      {id !== null ? (
                        <>
                          <button
                            type="button"
                            className="fp-btn"
                            disabled={state === "pending"}
                            onClick={() => retryFeed(id)}
                            aria-label={`Refresh ${typeof row.title === "string" && row.title ? row.title : `feed ${id}`} now`}
                          >
                            {state === "pending" ? "queuing…" : "refresh"}
                          </button>
                          {state && state !== "pending" ? (
                            <span className={`fp-hint${state === "queued" ? "" : " fp-status-bad"}`} role="status">
                              {state === "queued" ? "Queued." : state}
                            </span>
                          ) : null}
                        </>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(problemsOnly ? problems : rows).length > MAX_ROWS ? (
        <p className="fp-small fp-muted">Showing the first {MAX_ROWS.toLocaleString()}. Download the report for the full list.</p>
      ) : null}
    </>
  );
}

function DiagnosticsContent() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  // The first request starts on mount, so the page begins in the loading state.
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);
  const controller = useRef<AbortController | null>(null);

  // Replaces any earlier request; only the latest one may set state, and only once it settles.
  const request = useCallback(() => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    apiGet<Diagnostics>("/api/diagnostics", { signal: abort.signal }).then(
      (value) => {
        if (abort.signal.aborted) return;
        setData(isRecord(value) ? value : { value });
        setFetchedAt(new Date());
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (abort.signal.aborted) return;
        setError(describeError(reason, "Diagnostics could not be loaded."));
        setLoading(false);
      },
    );
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    request();
  }, [request]);

  useEffect(() => {
    request();
    return () => controller.current?.abort();
  }, [request]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  function download() {
    if (!data) return;
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), diagnostics: data }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fever-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (error && isSessionError(error)) {
    return <ErrorNotice title="Your session ended" error="Reload the page to log in again." onRetry={() => window.location.reload()} retryLabel="Reload" />;
  }

  const scalars: Record<string, unknown> = {};
  const sections: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(data ?? {})) {
    if (isRecord(value) || Array.isArray(value)) sections.push([key, value]);
    else scalars[key] = value;
  }

  return (
    <>
      <p>
        A read-only view of this installation&rsquo;s health. Passwords, API keys, feed credentials, and article content
        are never included.
      </p>
      <div className="fp-actions fp-start fp-flush">
        <button type="button" className="fp-btn fp-default" onClick={load} disabled={loading} aria-busy={loading || undefined}>
          {loading ? "Refreshing…" : "Refresh now"}
        </button>
        <label className="fp-choice">
          <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
          refresh every 30 seconds
        </label>
        <button type="button" className="fp-btn" onClick={download} disabled={!data}>Download report</button>
      </div>
      <p className="fp-small fp-muted" role="status" aria-live="polite">
        {fetchedAt ? `Updated ${fetchedAt.toLocaleTimeString()}.` : ""}
      </p>

      {error ? (
        <ErrorNotice title={data ? "Latest check failed" : "Diagnostics unavailable"} error={error} onRetry={load}>
          {data ? <p>Showing the last successful report from {fetchedAt?.toLocaleTimeString()}.</p> : null}
        </ErrorNotice>
      ) : null}
      {!data && !error ? <Loading>Collecting diagnostics…</Loading> : null}
      {data && !Object.keys(data).length ? <Notice><p>The server returned an empty report.</p></Notice> : null}

      {Object.keys(scalars).length ? (
        <section className="fp-section" aria-labelledby="fp-diag-summary">
          <h2 id="fp-diag-summary">Summary</h2>
          <KeyValues value={scalars} />
        </section>
      ) : null}
      {sections.map(([key, value]) => (
        <section className="fp-section" key={key} aria-labelledby={`fp-diag-${key}`}>
          <h2 id={`fp-diag-${key}`}>{humanize(key)}</h2>
          {Array.isArray(value) && value.some(isRecord)
            ? <RowsTable name={key} rows={value.filter(isRecord)} feedRows={/feed/i.test(key)} />
            : Array.isArray(value)
              ? <p className="fp-break">{value.length ? value.map(String).join(", ") : "None."}</p>
              : <SectionBody name={key} value={value as Record<string, unknown>} />}
        </section>
      ))}

      <div className="fp-actions">
        <a className="fp-btn" href={appHref("/maintenance")}>Maintenance</a>
        <a className="fp-btn fp-default" href={appHref("/")}>Done</a>
      </div>
    </>
  );
}

/** An object section may itself hold per-feed rows (e.g. feeds: {total, items: [...]}). */
function SectionBody({ name, value }: { name: string; value: Record<string, unknown> }) {
  const plain: Record<string, unknown> = {};
  const tables: Array<[string, Row[]]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && entry.length && entry.every(isRecord)) tables.push([key, entry as Row[]]);
    else plain[key] = entry;
  }
  return (
    <>
      {Object.keys(plain).length ? <KeyValues value={plain} /> : null}
      {tables.map(([key, rows]) => (
        <div key={key}>
          <h3>{humanize(key)}</h3>
          <RowsTable name={`${name} ${key}`} rows={rows} feedRows={/feed/i.test(name) || /feed/i.test(key)} />
        </div>
      ))}
    </>
  );
}

export function DiagnosticsPage() {
  return (
    <PageShell title="Diagnostics" subtitle="Installation health" width="xwide" nav>
      <SessionGate returnTo="/diagnostics" loginReason="Log in to see this installation's diagnostics.">{() => <DiagnosticsContent />}</SessionGate>
    </PageShell>
  );
}

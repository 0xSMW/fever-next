"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReaderView } from "@/lib/contracts";
import { ManagementDialog } from "@/components/manage/ManagementDialog";
import { apiGet, appHref, command } from "@/lib/client/api";
import { describeError, isSessionError, type DescribedError } from "./api-errors";
import { PageShell } from "./PageShell";
import { SessionGate } from "./SessionGate";
import { ErrorNotice, Loading, Notice } from "./Status";

type Operation = "flush" | "unorphan" | "empty" | "uninstall";
/** `?operation=` values: the dialog operations, plus "favicons" from the legacy `?empty-cache`. */
export type MaintenanceTarget = Operation | "favicons";

const OPERATIONS: Array<{ operation: Operation; title: string; description: string; keeps: string }> = [
  {
    operation: "unorphan",
    title: "Unorphan",
    description: "Deletes items whose feed no longer exists, including saved ones, and links whose feed or item no longer exists. The review step shows the counts before anything is deleted.",
    keeps: "Subscriptions, groups, preferences, every item that belongs to a feed, and an encrypted recovery snapshot.",
  },
  {
    operation: "flush",
    title: "Flush",
    description: "Deletes unsaved items, all Hot links, and cached favicons, and resets refresh history so every feed is fetched fresh. Each feed's title, site address, and domain are cleared and filled in again from the feed on its next refresh. Saved items are kept, and “[SURVIVED FLUSH]” is added to the end of each saved item's title.",
    keeps: "Subscriptions, groups and memberships, feed passwords and settings, titles you set yourself, preferences, saved items, the default feed icon, and an encrypted recovery snapshot.",
  },
  {
    operation: "empty",
    title: "Empty",
    description: "Unsubscribes from all feeds and deletes all groups, items, saved items, links, and cached favicons.",
    keeps: "Your login, Fever API access, preferences, sharing services, blacklist rules, the default feed icon, and an encrypted recovery snapshot.",
  },
  {
    operation: "uninstall",
    title: "Uninstall",
    description: "Disables this installation, signs out every browser and API client, and deletes all feeds, groups, items, favicons, preferences, Fever API access, sharing services, and blacklist rules. Setup stays closed, so the installation cannot be set up again or reactivated from a browser; the operator must restore it. The server program and database are not deleted.",
    keeps: "The locked installation record and owner account, audit and migration history, and an encrypted recovery snapshot the operator can restore. Export OPML first if you want your subscriptions.",
  },
];

function MaintenanceContent({ initial }: { initial: MaintenanceTarget | null }) {
  const [view, setView] = useState<ReaderView | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  // A legacy ?flush, ?empty, ?unorphan or ?uninstall link opens on that operation's
  // review step. Nothing runs until the dialog's password and typed confirmation.
  const [open, setOpen] = useState<null | { kind: "maintenance"; operation: Operation } | { kind: "export" }>(
    initial && initial !== "favicons" ? { kind: "maintenance", operation: initial } : null,
  );
  const [changed, setChanged] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<DescribedError | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const faviconsRef = useRef<HTMLElement | null>(null);

  const fetchView = useCallback(() => {
    apiGet<ReaderView>("/api/reader?capture=false").then(setView, (reason: unknown) => setError(describeError(reason, "Current totals could not be loaded.")));
  }, []);
  useEffect(fetchView, [fetchView]);
  const load = () => { setError(null); fetchView(); };

  useEffect(() => {
    if (initial === "favicons") faviconsRef.current?.scrollIntoView({ block: "start" });
  }, [initial]);

  async function clearFavicons() {
    if (clearing) return;
    setClearing(true);
    setClearError(null);
    try {
      const result = await command("favicons.clear", {});
      const cleared = typeof result.cleared === "number" ? result.cleared : null;
      // The server also queues a favicon-only refresh of every feed.
      const refetch = result.job ? " A refresh of every feed's icon is queued." : " Icons are fetched again on each feed's next refresh.";
      setChanged(cleared === null
        ? `The favicon cache was emptied.${refetch}`
        : `Removed ${cleared.toLocaleString()} cached ${cleared === 1 ? "favicon" : "favicons"}.${refetch}`);
    } catch (reason) {
      setClearError(describeError(reason, "The favicon cache could not be emptied."));
    } finally {
      setClearing(false);
    }
  }

  if (error && isSessionError(error)) {
    return <ErrorNotice title="Your session ended" error="Reload the page to log in again." onRetry={() => window.location.reload()} retryLabel="Reload" />;
  }

  const feeds = view?.feeds.length ?? 0;
  const sparks = view?.feeds.filter((feed) => feed.isSpark).length ?? 0;
  const groups = view?.groups.filter((group) => group.id > 0).length ?? 0;

  return (
    <>
      <p>
        These tools remove data in bulk. Each one shows exactly what it will delete and asks you to type a confirmation
        before anything changes. Cancelling at any point leaves your data untouched.
      </p>
      {changed ? <Notice tone="success" live><p>{changed}</p></Notice> : null}
      {error ? <ErrorNotice title="Totals unavailable" error={error} onRetry={load} /> : null}
      {!view && !error ? <Loading>Loading current totals…</Loading> : null}
      {view ? (
        <dl className="fp-kv">
          <dt>Feeds</dt><dd>{feeds.toLocaleString()}{sparks ? ` (${sparks.toLocaleString()} Sparks)` : ""}</dd>
          <dt>Groups</dt><dd>{groups.toLocaleString()}</dd>
          <dt>Saved items</dt><dd>{view.savedCount.toLocaleString()}</dd>
          <dt>Unread items</dt><dd>{view.unreadCount.toLocaleString()}</dd>
        </dl>
      ) : null}

      <section className="fp-section" aria-labelledby="fp-maint-export">
        <h2 id="fp-maint-export">Export first</h2>
        <p>
          An OPML export is a list of your subscriptions, arranged by group, that you can import again. It is not a
          backup: it does not include items, saved items, read state, Hot links, feed passwords, or Fever API
          credentials. A full backup is the operator&rsquo;s database backup.
        </p>
        <div className="fp-actions fp-start fp-flush">
          <a className="fp-btn fp-default" href={appHref("/api/opml/export")} download>Export OPML</a>
          <button
            type="button"
            className="fp-btn"
            onClick={(event) => { triggerRef.current = event.currentTarget; setOpen({ kind: "export" }); }}
          >
            Export options…
          </button>
        </div>
      </section>

      <section className="fp-section" aria-labelledby="fp-maint-ops">
        <h2 id="fp-maint-ops">Clean up</h2>
        <ul className="fp-ops">
          {OPERATIONS.map((entry) => (
            <li className="fp-op" key={entry.operation}>
              <div>
                <h3>{entry.title}</h3>
                <p>{entry.description}</p>
                <p className="fp-small fp-muted">Keeps: {entry.keeps}</p>
              </div>
              <button
                type="button"
                className={`fp-btn${entry.operation === "empty" || entry.operation === "uninstall" ? " fp-danger" : ""}`}
                aria-haspopup="dialog"
                aria-label={`Review ${entry.title}`}
                onClick={(event) => { triggerRef.current = event.currentTarget; setOpen({ kind: "maintenance", operation: entry.operation }); }}
              >
                Review…
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="fp-section" aria-labelledby="fp-maint-favicons" ref={faviconsRef}>
        <h2 id="fp-maint-favicons">Favicon cache</h2>
        {clearError ? <ErrorNotice title="Favicon cache not emptied" error={clearError} onRetry={clearFavicons} /> : null}
        <div className="fp-op">
          <div>
            <p>Deletes the cached site icons and queues a refresh that fetches each feed&rsquo;s icon again. Use this when icons look wrong or out of date.</p>
            <p className="fp-small fp-muted">Keeps: feeds, items, saved items, preferences, and the default feed icon.</p>
          </div>
          <button type="button" className="fp-btn" onClick={clearFavicons} disabled={clearing} aria-busy={clearing || undefined}>
            {clearing ? "Emptying…" : "Empty favicon cache"}
          </button>
        </div>
      </section>

      <div className="fp-actions">
        <a className="fp-btn fp-default" href={appHref("/")}>Done</a>
      </div>

      {open ? (() => {
        // The dialog receives the operation so it can open on its preview.
        const request = open.kind === "maintenance"
          ? { kind: "maintenance", operation: open.operation, ...(view ? { view } : {}) }
          : { kind: "export", ...(view ? { view } : {}) };
        return (
          <ManagementDialog
            request={request}
            onClose={() => { setOpen(null); requestAnimationFrame(() => triggerRef.current?.focus()); }}
            onChanged={() => {
              setChanged(open.kind === "maintenance"
                ? `${OPERATIONS.find((entry) => entry.operation === open.operation)?.title ?? "Maintenance"} finished.`
                : "Export ready.");
              load();
            }}
          />
        );
      })() : null}
    </>
  );
}

export function MaintenancePage({ operation = null }: { operation?: MaintenanceTarget | null }) {
  const returnTo = operation ? `/maintenance?operation=${operation}` : "/maintenance";
  return (
    <PageShell title="Maintenance" subtitle="Export, clean up, or start over" width="wide" nav>
      <SessionGate returnTo={returnTo} loginReason="Log in to manage this installation.">{() => <MaintenanceContent initial={operation} />}</SessionGate>
    </PageShell>
  );
}

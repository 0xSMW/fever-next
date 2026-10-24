"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Preferences, ReaderView } from "@/lib/contracts";
import { apiGet, appHref, command } from "@/lib/client/api";
import { describeError, type DescribedError } from "./api-errors";
import { CopyField, FeedletBookmarklet, useInstallUrls } from "./FeedletTools";
import { PageShell } from "./PageShell";
import { SessionGate } from "./SessionGate";
import { ErrorNotice, Loading, Notice } from "./Status";

/** `?section=` values. "refresh" comes from the legacy `?refresh` link (lib/compat/root.ts). */
export type ExtrasSection = "refresh";

function ExtrasContent({ section }: { section: ExtrasSection | null }) {
  const urls = useInstallUrls();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshQueued, setRefreshQueued] = useState(false);
  const [refreshError, setRefreshError] = useState<DescribedError | null>(null);
  const refreshRef = useRef<HTMLElement | null>(null);

  const fetchPreferences = useCallback(() => {
    apiGet<ReaderView>("/api/reader?capture=false").then(
      (view) => setPreferences(view.preferences),
      (reason: unknown) => setError(describeError(reason, "Your preferences could not be loaded.")),
    );
  }, []);
  useEffect(fetchPreferences, [fetchPreferences]);
  const retryLoad = () => { setError(null); fetchPreferences(); };

  useEffect(() => {
    if (section === "refresh") refreshRef.current?.scrollIntoView({ block: "start" });
  }, [section]);

  // The legacy ?refresh GET fetched feeds directly. Here a logged-in click queues
  // the same work for the worker; following a link alone never starts it.
  async function refreshAll() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    setRefreshQueued(false);
    try {
      await command("refresh.start", { scope: "all" });
      setRefreshQueued(true);
    } catch (reason) {
      setRefreshError(describeError(reason, "The refresh could not be queued."));
    } finally {
      setRefreshing(false);
    }
  }

  const interval = preferences?.refreshInterval ?? 15;

  return (
    <>
      <section className="fp-section" aria-labelledby="fp-extras-feedlet">
        <h2 id="fp-extras-feedlet">Feed a Fever</h2>
        <p>
          Drag the Feedlet onto your browser&rsquo;s bookmarks bar. On any page, click it to see the feeds that page
          offers, pick the ones you want, and set their groups and options before subscribing.
        </p>
        <div className="fp-actions fp-start fp-flush">
          <FeedletBookmarklet variant="full" />
          <FeedletBookmarklet variant="simple" />
        </div>
        <p className="fp-small">
          The Feedlet reads the page in your browser, including feed links that only appear after you log in to a site.
          Some sites block bookmarklets with a strict security policy. On those sites use <strong>Feedlet (simple)</strong>,
          which only sends the page address and lets Fever look for feeds itself. If a browser blocks both, copy the
          page address into the subscription page.
        </p>
        <p className="fp-small">
          The Feedlet only opens a confirmation page. Nothing is subscribed until you press Subscribe there, and a page
          cannot subscribe you on its own.
        </p>
        {urls ? (
          <details className="fp-row fp-row-stack">
            <summary>Install the Feedlet by hand (phones and tablets)</summary>
            <p className="fp-small" style={{ margin: "0.5rem 0" }}>
              Bookmark any page, edit the bookmark, and replace its address with one of these.
            </p>
            <CopyField label="Feedlet address" value={urls.feedletFull} />
            <CopyField label="Feedlet (simple) address" value={urls.feedletSimple} />
          </details>
        ) : null}
      </section>

      <section className="fp-section" aria-labelledby="fp-extras-subscribe">
        <h2 id="fp-extras-subscribe">Subscribe from other apps</h2>
        <p>
          Browsers, podcast apps, and other readers can send a feed address to Fever. Give them this subscription
          address; the feed&rsquo;s address is added to the end. Fever shows a confirmation before subscribing.
        </p>
        {urls ? <CopyField label="Subscription URL" value={urls.subscribe} /> : null}
        <div className="fp-actions fp-start fp-flush">
          <a className="fp-btn" href={appHref("/subscribe")}>Add a feed by address</a>
        </div>
      </section>

      <section className="fp-section" aria-labelledby="fp-extras-refresh" ref={refreshRef}>
        <h2 id="fp-extras-refresh">Nobody likes to wait</h2>
        {section === "refresh" ? (
          <Notice tone="warning">
            <p>You followed an old <code>?refresh</code> link. It no longer refreshes feeds by itself. Use the button below, or set up the worker as described here.</p>
          </Notice>
        ) : null}
        {refreshQueued ? <Notice tone="success" live><p>Refresh queued. The worker fetches every feed now; new items appear in the reader as they arrive.</p></Notice> : null}
        {refreshError ? <ErrorNotice title="Refresh not queued" error={refreshError} onRetry={refreshAll} /> : null}
        <div className="fp-actions fp-start fp-flush">
          <button type="button" className="fp-btn" onClick={refreshAll} disabled={refreshing} aria-busy={refreshing || undefined}>
            {refreshing ? "Queuing…" : "Refresh all feeds now"}
          </button>
        </div>
        {error ? <ErrorNotice title="Preferences unavailable" error={error} onRetry={retryLoad} /> : null}
        {!preferences && !error ? <Loading>Loading your refresh settings…</Loading> : null}
        <p>
          Fever refreshes feeds with its own background worker, a separate process that runs next to the web server.
          It refreshes feeds that are due every {interval} {interval === 1 ? "minute" : "minutes"}, whether or not a
          browser is open.
          {preferences ? (preferences.autoRefresh
            ? " While the reader is open it also asks the worker for a refresh when feeds are due."
            : " Refreshing from an open reader is turned off in Preferences.") : null}
        </p>
        <p>
          The operator starts the worker with <code>pnpm worker</code> under the server&rsquo;s process supervisor, which
          keeps it running and passes it the server&rsquo;s configuration. Nothing needs to go in cron. To queue a refresh
          from the server&rsquo;s own shell, run <code>pnpm refresh</code>. It only adds the work to the queue and exits;
          the running worker fetches the feeds. Both commands use the server&rsquo;s configuration, so they need no URL,
          password, or token, and nothing is exposed to the internet. The operations guide for this release has the details.
        </p>
        <p>
          The old cron line that requested <code>?refresh</code> with curl no longer works: Fever refuses anonymous
          refresh requests so that nobody else can make your server fetch feeds. Remove it from your crontab. Never add
          <code> -k</code> or <code>--insecure</code> to a curl command for Fever; it turns off certificate checks and
          lets anyone on the network impersonate your server.
        </p>
      </section>

      <section className="fp-section" aria-labelledby="fp-extras-privacy">
        <h2 id="fp-extras-privacy">Privacy</h2>
        <p>
          When you open an article, your browser normally tells the site which page linked to it (the referrer).
          {preferences ? (preferences.anonymize
            ? " Anonymous link opening is on: Fever asks your browser not to send your Fever address to the sites you visit."
            : " Anonymous link opening is off. Turn it on in Preferences → Behavior to stop sites from seeing your Fever address.") : null}
        </p>
        {preferences ? (
          preferences.share ? (
            <>
              <p>
                Your saved items are published as a public RSS feed. Anyone with this address can read the 30 most
                recent saved items, and it is advertised on your login page. Turn it off in Preferences → Sharing.
              </p>
              {urls ? <CopyField label="Saved items feed" value={`${urls.base}/rss/saved`} /> : null}
            </>
          ) : (
            <p>Your saved items are private. You can publish them as an RSS feed in Preferences → Sharing.</p>
          )
        ) : null}
      </section>

      <div className="fp-actions">
        <a className="fp-btn fp-default" href={appHref("/")}>Done</a>
      </div>
    </>
  );
}

export function ExtrasPage({ section = null }: { section?: ExtrasSection | null }) {
  return (
    <PageShell title="Extras" subtitle="Subscribe from anywhere and keep feeds fresh" width="wide" nav>
      <SessionGate returnTo={section ? `/extras?section=${section}` : "/extras"}>{() => <ExtrasContent section={section} />}</SessionGate>
    </PageShell>
  );
}

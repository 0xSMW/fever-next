"use client";
import { feedletFeedInput } from "../forms/feed-draft";
import { useReaderData } from "@/lib/client/useReaderData";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { FeedCandidate, FeedInput } from "@/lib/contracts";
import { apiPost, appHref } from "@/lib/client/api";
import { describeError, isSessionError, type DescribedError } from "@/lib/client/errors";
import {
  comparisonKey, displayUrl, fromServer, fromSupplied, groupCandidates,
  type CandidateGroup, type SuppliedFeed,
} from "./feedlet-candidates";
import { defaultFeedOptions, FeedOptionsDialog, hasCustomOptions, type FeedOptions } from "./FeedOptionsDialog";
import { safeExternalUrl } from "./return-path";
import { ErrorNotice, Loading, Notice } from "./Status";

interface SubscribeResult { added: number; ids: number[]; warnings: string[] }

interface FeedSubscribeFlowProps {
  mode: "feedlet" | "subscribe";
  /** Page the Feedlet ran on, or the URL passed to the subscription address. */
  initialUrl: string | null;
  pageTitle?: string;
  supplied?: SuppliedFeed[];
  rejected?: number;
  /** Reports the heading for the page box. */
  onHeading?: (heading: string) => void;
}

type Discovery =
  | { state: "idle" }
  | { state: "loading"; url: string }
  | { state: "error"; url: string; error: DescribedError }
  | { state: "done"; url: string; candidates: FeedCandidate[] };

/**
 * Feedlet and subscription-URL confirmation. Loading this page never changes
 * anything: discovery is a read-only POST and subscribing happens only when
 * the user presses Subscribe (POST /api/subscribe).
 */
export function FeedSubscribeFlow({ mode, initialUrl, pageTitle = "", supplied = [], rejected = 0, onHeading }: FeedSubscribeFlowProps) {
  const id = useId();
  const { view, error: viewError, reload: loadView } = useReaderData();
  // Server discovery is the fallback when the bookmarklet found nothing
  // (old "simple" Feedlet links and subscription URLs supply none).
  const autoDiscoverUrl = initialUrl && supplied.length === 0 ? initialUrl : null;
  const [discovery, setDiscovery] = useState<Discovery>(() => (autoDiscoverUrl ? { state: "loading", url: autoDiscoverUrl } : { state: "idle" }));
  const [autoDiscovered, setAutoDiscovered] = useState(autoDiscoverUrl);
  if (autoDiscovered !== autoDiscoverUrl) {
    setAutoDiscovered(autoDiscoverUrl);
    // The effect below cancels the running discovery when this address changes.
    if (autoDiscoverUrl) setDiscovery({ state: "loading", url: autoDiscoverUrl });
    else if (discovery.state === "loading") setDiscovery({ state: "idle" });
  }
  const [urlInput, setUrlInput] = useState(initialUrl ?? "");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [options, setOptions] = useState<Record<string, FeedOptions>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<DescribedError | null>(null);
  const [result, setResult] = useState<SubscribeResult | null>(null);
  const discoveryController = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Replaces any earlier discovery; only the latest one may set state, and only once it settles.
  const requestDiscovery = useCallback((url: string) => {
    discoveryController.current?.abort();
    const abort = new AbortController();
    discoveryController.current = abort;
    apiPost<{ candidates: FeedCandidate[] }>("/api/discover", { url }, { signal: abort.signal }).then(
      (response) => {
        if (abort.signal.aborted) return;
        setDiscovery({ state: "done", url, candidates: Array.isArray(response?.candidates) ? response.candidates : [] });
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setDiscovery({ state: "error", url, error: describeError(error, "Fever could not read that address.") });
      },
    );
  }, []);

  const discover = (url: string) => {
    setDiscovery({ state: "loading", url });
    requestDiscovery(url);
  };

  // The loading state for this address was set during render, above.
  useEffect(() => {
    if (autoDiscoverUrl) requestDiscovery(autoDiscoverUrl);
    return () => discoveryController.current?.abort();
  }, [autoDiscoverUrl, requestDiscovery]);

  const subscribedKeys = useMemo(() => new Set((view?.feeds ?? []).map((feed) => comparisonKey(feed.url))), [view]);

  const groups: CandidateGroup[] = useMemo(() => {
    const raw = supplied.map(fromSupplied);
    if (discovery.state === "done") {
      for (const candidate of discovery.candidates) {
        const converted = fromServer(candidate);
        if (converted) raw.push(converted);
      }
    }
    return groupCandidates(raw, subscribedKeys);
  }, [supplied, discovery, subscribedKeys]);

  const addable = groups.filter((group) => !group.variants[options[group.key]?.variantIndex ?? group.defaultIndex]?.subscribed);
  const subscribedCount = groups.length - addable.length;
  const preferences = view?.preferences ?? null;

  // Source behaviour: a single candidate starts selected; an explicit choice overrides it.
  const soleKey = groups.length === 1 && addable.length === 1 ? groups[0].key : null;
  const isSelected = (key: string) => selected[key] ?? key === soleKey;

  useEffect(() => {
    const host = (() => { try { return initialUrl ? new URL(initialUrl).hostname.replace(/^www\./, "") : ""; } catch { return ""; } })();
    const label = pageTitle || host || "this page";
    if (mode === "feedlet") onHeading?.(`Subscribe to ${groups.length === 1 ? "a feed" : "feeds"} on ${label}`);
    else onHeading?.(initialUrl ? `Confirm subscription to ${displayUrl(initialUrl)}` : "Add a feed by address");
  }, [mode, groups.length, pageTitle, initialUrl, onHeading]);

  const optionsFor = (group: CandidateGroup) => options[group.key] ?? defaultFeedOptions(group, preferences);
  const selectedGroups = addable.filter((group) => isSelected(group.key));
  const allSelected = addable.length > 0 && selectedGroups.length === addable.length;

  function toggleAll() {
    const next: Record<string, boolean> = {};
    for (const group of addable) next[group.key] = !allSelected;
    setSelected(next);
    setSelectError(null);
  }

  function lookUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = urlInput.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `http://${value}`;
    const url = value ? safeExternalUrl(withScheme) : null;
    if (!url) {
      setUrlError(value ? "Enter a web page or feed address that starts with http:// or https://." : "Enter a web page or feed address.");
      return;
    }
    setUrlError(null);
    setResult(null);
    discover(url);
  }

  async function subscribe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!selectedGroups.length) {
      setSelectError("Select at least one feed to subscribe to.");
      listRef.current?.querySelector<HTMLInputElement>("input[type=checkbox]:not(:disabled)")?.focus();
      return;
    }
    setSelectError(null);
    setSubmitError(null);
    const feeds: FeedInput[] = selectedGroups.map((group) => {
      const chosen = optionsFor(group);
      const variant = group.variants[chosen.variantIndex] ?? group.variants[group.defaultIndex];
      return feedletFeedInput(variant.url, chosen);
    });
    setSubmitting(true);
    try {
      const response = await apiPost<SubscribeResult>("/api/subscribe", { feeds });
      setResult({
        added: Number(response?.added) || 0,
        ids: Array.isArray(response?.ids) ? response.ids : [],
        warnings: Array.isArray(response?.warnings) ? response.warnings.filter((entry): entry is string => typeof entry === "string") : [],
      });
      // Credentials are not kept in page state after a successful submit.
      setOptions((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, { ...value, username: "", password: "" }])));
      setSelected({});
      loadView();
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (error) {
      setSubmitError(describeError(error, "The subscription was not saved."));
    } finally {
      setSubmitting(false);
    }
  }

  const returnUrl = initialUrl ? safeExternalUrl(initialUrl) : null;

  if (viewError && isSessionError(viewError)) {
    return <ErrorNotice title="Your session ended" error="Reload the page to log in again." onRetry={() => window.location.reload()} retryLabel="Reload" />;
  }

  if (result) {
    const failed = result.warnings.length > 0;
    return (
      <div ref={resultRef} tabIndex={-1}>
        <Notice tone={result.added > 0 ? "success" : "warning"} live>
          <p>
            {result.added > 0
              ? `Subscribed to ${result.added} new ${result.added === 1 ? "feed" : "feeds"}. Fever is fetching ${result.added === 1 ? "it" : "them"} now.`
              : "No new subscriptions were added."}
          </p>
          {failed ? (
            <ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          ) : null}
        </Notice>
        <div className="fp-actions">
          {returnUrl ? <a className="fp-btn" href={returnUrl} rel="noopener noreferrer">Back to {displayUrl(returnUrl).split("/")[0]}</a> : null}
          <button type="button" className="fp-btn" onClick={() => setResult(null)}>Subscribe to more</button>
          <a className="fp-btn fp-default" href={appHref("/")}>Open Fever</a>
        </div>
      </div>
    );
  }

  const showUrlForm = mode === "subscribe" || !initialUrl;

  return (
    <>
      {showUrlForm ? (
        <form onSubmit={lookUp} noValidate className="fp-rows" role="search" aria-label="Find feeds">
          <div className="fp-row">
            <label className="fp-label" htmlFor={`${id}-url`}>Address</label>
            <div className="fp-field">
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  id={`${id}-url`} type="url" inputMode="url" autoCapitalize="off" spellCheck={false}
                  value={urlInput} onChange={(event) => setUrlInput(event.target.value)}
                  placeholder="https://example.com/"
                  aria-invalid={urlError ? true : undefined}
                  aria-describedby={`${id}-url-hint${urlError ? ` ${id}-url-error` : ""}`}
                  autoFocus={!initialUrl}
                />
                <button type="submit" className="fp-btn" disabled={discovery.state === "loading"}>find feeds</button>
              </div>
              <span className="fp-hint" id={`${id}-url-hint`}>A feed address or any web page that links to its feeds.</span>
              {urlError ? <span className="fp-field-error" id={`${id}-url-error`}>{urlError}</span> : null}
            </div>
          </div>
        </form>
      ) : null}

      {rejected > 0 ? (
        <Notice tone="warning"><p>{rejected === 1 ? "One link" : `${rejected} links`} from the page could not be used because {rejected === 1 ? "it is not" : "they are not"} a plain web address.</p></Notice>
      ) : null}
      {viewError ? (
        <ErrorNotice title="Some details are missing" error={viewError} onRetry={loadView}>
          <p>You can still subscribe, but already-subscribed feeds may not be marked and group choices are unavailable.</p>
        </ErrorNotice>
      ) : null}
      {discovery.state === "loading" ? <Loading>Looking for feeds on {displayUrl(discovery.url)}…</Loading> : null}
      {discovery.state === "error" ? (
        <ErrorNotice title="Feeds could not be found" error={discovery.error} onRetry={() => discover(discovery.url)}>
          {discovery.error.status === 401 || discovery.error.code === "AUTH_REQUIRED" ? (
            <p>The page asked for a login. Fever cannot see pages behind your browser login. If you know the feed address, enter it directly and add credentials under Options.</p>
          ) : null}
        </ErrorNotice>
      ) : null}
      {discovery.state === "done" && groups.length === 0 ? (
        <Notice tone="warning" live>
          <p>No feeds found on {displayUrl(discovery.url)}.{/(login|account|user|admin)/i.test(discovery.url) ? " Login may be required to access the requested page." : ""}</p>
        </Notice>
      ) : null}
      {groups.some((group) => group.variants.some((variant) => variant.guessed)) ? (
        <p className="fp-small">Feeds marked <span className="fp-tag fp-tag-guess">guess</span> were found from link text or a link address and may not be real feeds. Each address is shown under its title.</p>
      ) : null}

      {groups.length > 0 ? (
        <form onSubmit={subscribe} noValidate aria-describedby={selectError ? `${id}-select-error` : undefined}>
          {mode === "feedlet" && supplied.length > 0 && initialUrl && discovery.state === "idle" ? (
            <p className="fp-small">
              Missing a feed?{" "}
              <button type="button" className="fp-btn" onClick={() => discover(initialUrl)}>search the page from Fever</button>
            </p>
          ) : null}
          <ul className="fp-candidates" ref={listRef} aria-label="Feeds found">
            {groups.map((group) => {
              const chosen = optionsFor(group);
              const variant = group.variants[chosen.variantIndex] ?? group.variants[group.defaultIndex];
              const custom = hasCustomOptions(chosen, group, preferences);
              const checkboxId = `${id}-feed-${group.key.replace(/[^a-z0-9]+/gi, "-")}-${groups.indexOf(group)}`;
              const tags = (
                <span className="fp-tags">
                  {variant.subscribed ? <span className="fp-tag fp-tag-subscribed">subscribed</span> : null}
                  {variant.guessed ? <span className="fp-tag fp-tag-guess">guess</span> : null}
                  {variant.requiresAuth ? <span className="fp-tag fp-tag-auth">login required</span> : null}
                  {group.variants.length > 1 ? <span className="fp-tag">{group.variants.length} formats</span> : null}
                  {chosen.username ? <span className="fp-tag fp-tag-auth">credentials added</span> : null}
                  {custom ? <span className="fp-tag fp-tag-options">options set</span> : null}
                  {chosen.isSpark && !variant.subscribed ? <span className="fp-tag">Spark</span> : null}
                </span>
              );
              const classes = `fp-candidate${variant.guessed ? " fp-is-guess" : ""}${variant.subscribed ? " fp-is-subscribed" : ""}`;
              if (variant.subscribed) {
                return (
                  <li key={group.key} className={classes}>
                    <div className="fp-candidate-main">
                      <span className="fp-candidate-title">Already subscribed to <strong>{group.title}</strong></span>
                      <span className="fp-url">{variant.url}</span>
                      {tags}
                    </div>
                  </li>
                );
              }
              return (
                <li key={group.key} className={classes}>
                  <div className="fp-candidate-main">
                    <label htmlFor={checkboxId}>
                      <input
                        id={checkboxId}
                        type="checkbox"
                        checked={isSelected(group.key)}
                        onChange={(event) => { setSelected((current) => ({ ...current, [group.key]: event.target.checked })); setSelectError(null); }}
                        aria-describedby={`${checkboxId}-url`}
                      />
                      <span className="fp-candidate-title">Add <strong>{group.title}</strong></span>
                    </label>
                    <span className="fp-url" id={`${checkboxId}-url`}>{variant.url}</span>
                    {tags}
                  </div>
                  <button
                    type="button"
                    className="fp-btn"
                    onClick={() => setEditing(group.key)}
                    aria-label={`Options for ${group.title}`}
                    aria-haspopup="dialog"
                  >
                    options
                  </button>
                </li>
              );
            })}
          </ul>
          {selectError ? <p className="fp-field-error" id={`${id}-select-error`} role="alert">{selectError}</p> : null}
          {submitError ? (
            <ErrorNotice title="Subscription failed" error={submitError}>
              {isSessionError(submitError) ? <p>Your session ended. Reload the page to log in again; your choices will need to be made again.</p> : null}
            </ErrorNotice>
          ) : null}
          {submitting ? <Loading>Subscribing…</Loading> : null}
          <div className="fp-actions">
            {addable.length > 1 ? (
              <button type="button" className="fp-btn" onClick={toggleAll} aria-pressed={allSelected}>{allSelected ? "Deselect all" : "Select all"}</button>
            ) : null}
            <span className="fp-spacer" />
            {returnUrl && mode === "feedlet"
              ? <a className="fp-btn" href={returnUrl} rel="noopener noreferrer">Cancel</a>
              : <a className="fp-btn" href={appHref("/")}>Cancel</a>}
            {addable.length > 0 ? (
              <button type="submit" className="fp-btn fp-default" disabled={submitting} aria-busy={submitting || undefined}>
                {submitting ? "Subscribing…" : selectedGroups.length > 1 ? `Subscribe to ${selectedGroups.length}` : "Subscribe"}
              </button>
            ) : null}
          </div>
          {subscribedCount > 0 && addable.length === 0 ? (
            <p className="fp-small fp-muted">You are already subscribed to every feed found here.</p>
          ) : null}
        </form>
      ) : (
        <div className="fp-actions">
          {returnUrl && mode === "feedlet"
            ? <a className="fp-btn" href={returnUrl} rel="noopener noreferrer">Cancel</a>
            : <a className="fp-btn" href={appHref("/")}>Cancel</a>}
        </div>
      )}

      {editing ? (() => {
        const group = groups.find((entry) => entry.key === editing);
        if (!group) return null;
        return (
          <FeedOptionsDialog
            group={group}
            options={optionsFor(group)}
            groups={(view?.groups ?? []).filter((entry) => entry.id > 0)}
            preferences={preferences}
            onCancel={() => setEditing(null)}
            onDone={(next) => {
              setOptions((current) => ({ ...current, [group.key]: next }));
              const variant = group.variants[next.variantIndex];
              // Source dismissOptions(): finishing the options selects the feed.
              if (variant && !variant.subscribed) setSelected((current) => ({ ...current, [group.key]: true }));
              setEditing(null);
            }}
          />
        );
      })() : null}
    </>
  );
}

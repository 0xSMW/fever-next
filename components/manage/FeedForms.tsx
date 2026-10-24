"use client";
import { globalDisplay, type DisplayValues, DisplayOverrides } from "../forms/DisplayOverrides";

import { useId, useMemo, useState } from "react";
import { apiPost, command, errorMessage } from "@/lib/client/api";
import type { FeedCandidate, FeedDTO, ReaderView } from "@/lib/contracts";
import { feedRefreshFailed } from "../reader/model";
import { TabPanel, type TabSpec } from "../forms/Tabs";
import {
  Button, Checkbox, ErrorBanner, Footer, Frame, MultiSelect, Row, StatusBanner,
  TextField, feedTitle, fieldError, localError,
  plural, safeHttpUrl, useAction, usePanel, type FormError,
} from "./shared";

import { createFeedDraft, managementFeedInput, updateFeedInput } from "../forms/feed-draft";

type FeedTab = "feed" | "display" | "authentication";

const FIELD_TABS: Record<string, FeedTab> = {
  url: "feed", title: "feed", groupIds: "feed", isSpark: "feed", preventsHotlinking: "feed",
  sortOrder: "display", itemAllows: "display", itemExcerpts: "display", unreadCounts: "display",
  username: "authentication", password: "authentication", clearCredentials: "authentication",
};

function tabsWithErrors(error: FormError | null): Set<FeedTab> {
  const tabs = new Set<FeedTab>();
  if (error) for (const field of Object.keys(error.fields)) tabs.add(FIELD_TABS[field] ?? "feed");
  return tabs;
}

function firstErrorTab(error: FormError | null | undefined, order: readonly FeedTab[]): FeedTab | undefined {
  if (!error) return undefined;
  const tabs = tabsWithErrors(error);
  return order.find((tab) => tabs.has(tab));
}

/** feed:// becomes http:// as in Fever's add_feed; a bare host gets http://. */
function normalizeFeedUrl(value: string): string {
  const trimmed = value.trim().replace(/^feed:\/\//i, "http://");
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function validFeedUrl(value: string): boolean {
  try {
    const url = new URL(normalizeFeedUrl(value));
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ add / edit */

export function FeedEditor({ mode, feed, view, initialTab = "feed" }: {
  mode: "add" | "edit"; feed?: FeedDTO; view: ReaderView; initialTab?: FeedTab;
}) {
  const panel = usePanel();
  const save = useAction();
  const discover = useAction();
  const refresh = useAction();
  const recache = useAction();
  const preferences = view.preferences;

  const defaultGroupIds = mode === "add" && view.view.section === "kindling" && view.view.groupId > 0 ? [view.view.groupId] : [];
  const [initialDraft] = useState(() => createFeedDraft(preferences, feed, defaultGroupIds));
  const [tab, setTab] = useState<FeedTab>(initialTab);
  const [url, setUrl] = useState(feed?.url ?? "");
  // Only the owner's override is editable; a blank title follows the feed's own.
  const [title, setTitle] = useState(initialDraft.title);
  const [groupIds, setGroupIds] = useState<number[]>(initialDraft.groupIds);
  const [isSpark, setIsSpark] = useState(initialDraft.isSpark);
  const [sparkNote, setSparkNote] = useState(false);
  const [preventsHotlinking, setPreventsHotlinking] = useState(initialDraft.preventsHotlinking);
  const [display, setDisplay] = useState<DisplayValues>(initialDraft.display);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [clearCredentials, setClearCredentials] = useState(false);
  const [duplicate, setDuplicate] = useState<FeedDTO | { id: number } | null>(null);
  const [candidates, setCandidates] = useState<FeedCandidate[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const candidateName = useId();

  const groupOptions = useMemo(
    () => view.groups.filter((group) => group.id > 0)
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
      .map((group) => ({ id: group.id, label: group.title })),
    [view.groups],
  );

  const error = save.error;
  const errorTabs = tabsWithErrors(error);
  const tabs: TabSpec<FeedTab>[] = [
    { id: "feed", label: "Feed", invalid: errorTabs.has("feed") },
    { id: "display", label: "Display", invalid: errorTabs.has("display") },
    { id: "authentication", label: "Authentication", invalid: errorTabs.has("authentication") },
  ];

  const changeGroups = (ids: number[]) => {
    setGroupIds(ids);
    // Fever clears the Spark box whenever the group selection changes.
    if (isSpark) { setIsSpark(false); setSparkNote(true); }
  };

  const validate = (): FormError | null => {
    const fields: Record<string, string> = {};
    if (!url.trim()) fields.url = "Enter the feed's address.";
    else if (!validFeedUrl(url)) fields.url = "Enter an http:// or https:// address without a username or password in it.";
    if (title.length > 1024) fields.title = "Use a title of 1,024 characters or fewer.";
    if (!clearCredentials && password && !username.trim()) fields.username = "Enter the username that goes with this password.";
    return localError(fields);
  };

  const draft = () => ({ title, groupIds, isSpark, preventsHotlinking, display, username, password, clearCredentials });

  const submit = async () => {
    setDuplicate(null);
    setWarning(null);
    const invalid = validate();
    if (invalid) {
      save.setError(invalid);
      setTab(firstErrorTab(invalid, ["feed", "display", "authentication"]) ?? tab);
      return;
    }
    const result = await save.run(async () => {
      if (mode === "edit" && feed) {
        const response = await command("feed.update", updateFeedInput(feed.id, normalizeFeedUrl(url), draft()));
        return { id: response.id, duplicate: false, refreshWarning: null };
      }
      const response = await command("feed.create", managementFeedInput(normalizeFeedUrl(url), draft()));
      return { id: response.id, duplicate: !response.created, refreshWarning: response.warnings.join(" ") || null };
    });
    if (!result.ok) {
      const errorTab = firstErrorTab(result.error, ["feed", "display", "authentication"]);
      if (errorTab) setTab(errorTab);
      return;
    }
    const { id, duplicate: isDuplicate, refreshWarning } = result.value;
    if (isDuplicate) {
      const existing = view.feeds.find((entry) => entry.id === id);
      setDuplicate(existing ?? (id ? { id } : { id: 0 }));
      setTab("feed");
      return;
    }
    await panel.changed();
    if (refreshWarning) {
      setWarning(`The feed was added, but ${refreshWarning.charAt(0).toLowerCase()}${refreshWarning.slice(1)} Refresh it from the reader.`);
      return;
    }
    panel.close();
  };

  const findFeeds = async () => {
    setCandidates(null);
    if (!url.trim() || !validFeedUrl(url)) {
      discover.setError(localError({ url: "Enter a website or feed address to search." }));
      setTab("feed");
      return;
    }
    const result = await discover.run(() => apiPost<{ candidates: FeedCandidate[] }>("/api/discover", { url: normalizeFeedUrl(url) }));
    if (result.ok) setCandidates(Array.isArray(result.value.candidates) ? result.value.candidates : []);
  };

  const refreshNow = async () => {
    if (!feed) return;
    setNotice(null);
    const result = await refresh.run(() => command("refresh.start", { scope: "feed", id: feed.id, force: true }));
    if (result.ok) {
      setNotice("Refresh queued. New items appear in the reader as the feed is fetched.");
      await panel.changed();
    }
  };

  const recacheFavicon = async () => {
    if (!feed) return;
    setNotice(null);
    const result = await recache.run(() => command("refresh.start", { scope: "feed", id: feed.id, force: true, faviconOnly: true }));
    if (result.ok) {
      setNotice("Favicon refresh queued. The new icon appears once Fever fetches it from the site.");
      await panel.changed();
    }
  };

  if (warning) {
    return (
      <Frame title="Add a feed" size="normal" footer={<Footer cancelLabel="Close" />}>
        <StatusBanner tone="warning">{warning}</StatusBanner>
      </Frame>
    );
  }

  const siteHref = safeHttpUrl(feed?.siteUrl);
  const urlError = fieldError(error, "url") ?? fieldError(discover.error, "url");
  const shownError = error ?? discover.error ?? refresh.error ?? recache.error;

  return (
    <Frame
      title={mode === "add" ? "Add a feed" : "Edit feed"}
      tabs={tabs}
      activeTab={tab}
      onTabChange={setTab}
      onSubmit={submit}
      busy={save.pending}
      size="wide"
      footer={(
        <Footer
          submitLabel="Save"
          pendingLabel="Saving…"
          pending={save.pending}
          extra={mode === "edit" && feed ? (
            <>
              <Button onClick={refreshNow} pending={refresh.pending}>{refresh.pending ? "Queuing…" : "Refresh now"}</Button>
              <Button onClick={recacheFavicon} pending={recache.pending}>{recache.pending ? "Queuing…" : "Refresh favicon"}</Button>
              {siteHref && (
                <a className="fm-btn fm-btn-plain" href={siteHref} target="_blank" rel="noopener noreferrer">Visit site</a>
              )}
            </>
          ) : undefined}
        />
      )}
    >
      <ErrorBanner error={shownError} />
      {notice && <StatusBanner tone="success">{notice}</StatusBanner>}
      {duplicate && (
        <StatusBanner tone="warning">
          {"title" in duplicate
            ? <>You are already subscribed to this feed as <strong>{feedTitle(duplicate)}</strong>. Nothing was changed.</>
            : <>You are already subscribed to this feed. Nothing was changed.</>}
          {"title" in duplicate && (
            <> <button type="button" className="fm-link" onClick={() => panel.navigate({ kind: "edit-feed", feed: duplicate, view })}>Edit that feed</button></>
          )}
        </StatusBanner>
      )}
      {mode === "edit" && feed?.requiresAuth && (
        <StatusBanner tone="warning">
          This feed needs a username and password. Enter them on the Authentication tab, then save.
        </StatusBanner>
      )}
      {mode === "edit" && feed?.lastError && !feed.requiresAuth && (
        <StatusBanner tone="warning">
          {feedRefreshFailed(feed) ? "Last refresh failed" : "Last refresh reported"}: {feed.lastError}
        </StatusBanner>
      )}

      <TabPanel tab="feed" active={tab === "feed"}>
        <TextField
          label="Feed url"
          value={url}
          onChange={(event) => setUrl(event.currentTarget.value)}
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="https://example.com/feed"
          required
          error={urlError}
          data-autofocus={mode === "add" ? "" : undefined}
          hint={(
            <span className="fm-inline-actions">
              {mode === "add" ? "A website address works too. " : ""}
              <button type="button" className="fm-link" onClick={findFeeds} disabled={discover.pending}>
                {discover.pending ? "Looking for feeds…" : "Find feeds at this address"}
              </button>
            </span>
          )}
        />
        {candidates && (
          <fieldset className="fm-row fm-candidates">
            <legend className="fm-row-label">Feeds found</legend>
            <div className="fm-row-control" aria-live="polite">
              {candidates.length === 0 ? (
                <p className="fm-empty">No feeds were found at this address. Check it, or enter the feed&apos;s own address.</p>
              ) : (
                <ul className="fm-candidate-list">
                  {candidates.map((candidate) => (
                    <li key={candidate.url}>
                      <label className="fm-radio">
                        <input type="radio" name={candidateName} checked={url.trim() === candidate.url}
                          disabled={candidate.subscribed}
                          onChange={() => setUrl(candidate.url)} />
                        <span>
                          <strong>{candidate.title || candidate.url}</strong>{" "}
                          <span className="fm-muted">{candidate.type}</span>
                          {candidate.guessed && <span className="fm-tag">guess</span>}
                          {candidate.subscribed && <span className="fm-tag">already subscribed</span>}
                          <span className="fm-candidate-url">{candidate.url}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </fieldset>
        )}
        <TextField
          label="Feed title"
          help="feed-title"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder={mode === "edit" ? feed?.sourceTitle || "Title provided by feed" : "Optional"}
          error={fieldError(error, "title")}
          data-autofocus={mode === "edit" ? "" : undefined}
        />
        <Row label="Images" help="hotlinking" labelAs="span">
          <Checkbox label="site prevents hotlinking" checked={preventsHotlinking} onChange={setPreventsHotlinking} />
        </Row>
        <MultiSelect
          legend={mode === "add" ? "Add to group(s)" : "In group(s)"}
          help="multiple"
          options={groupOptions}
          selected={groupIds}
          onChange={changeGroups}
          emptyText="You have no groups yet. The feed still appears in Kindling."
          error={fieldError(error, "groupIds")}
        />
        <Row labelAs="span" error={fieldError(error, "isSpark")}>
          <Checkbox
            label={mode === "add" ? "add to Sparks" : "is a Spark"}
            help="sparks"
            checked={isSpark}
            onChange={(checked) => { setIsSpark(checked); setSparkNote(false); }}
            hint={sparkNote
              ? "Changing groups moved this feed out of Sparks. Check the box again to keep it a Spark."
              : "A Spark keeps its group memberships, but they are hidden while it is a Spark."}
          />
        </Row>
      </TabPanel>

      <TabPanel tab="display" active={tab === "display"}>
        <DisplayOverrides
          value={display}
          onChange={setDisplay}
          inheritLabel="group default"
          inherited={globalDisplay(preferences)}
          inheritedFrom="the selected group, or your Display preferences when the group has no override"
          errors={error}
        />
      </TabPanel>

      <TabPanel tab="authentication" active={tab === "authentication"}>
        <p className="fm-hint fm-panel-intro">
          Optional. Some feeds require a username and password. Fever stores them encrypted and never shows them again.
        </p>
        {mode === "edit" && feed?.requiresAuth && !clearCredentials && (
          <p className="fm-hint">Leave both fields blank to keep the saved credentials.</p>
        )}
        <TextField
          label="Username"
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={clearCredentials}
          error={fieldError(error, "username")}
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          autoComplete="new-password"
          disabled={clearCredentials}
          error={fieldError(error, "password")}
        />
        {mode === "edit" && (
          <Row labelAs="span" error={fieldError(error, "clearCredentials")}>
            <Checkbox
              label="remove saved credentials"
              checked={clearCredentials}
              onChange={(checked) => { setClearCredentials(checked); if (checked) { setUsername(""); setPassword(""); } }}
              hint="Fever will fetch this feed without a username and password."
            />
          </Row>
        )}
      </TabPanel>
    </Frame>
  );
}

/* ------------------------------------------------------------------ delete */

export function DeleteFeed({ feed, view }: { feed: FeedDTO; view: ReaderView }) {
  const panel = usePanel();
  const action = useAction();
  const memberships = view.groups.filter((group) => group.id > 0 && feed.groupIds.includes(group.id));

  const submit = async () => {
    const result = await action.run(() => command("feed.delete", { id: feed.id, confirm: true }));
    if (!result.ok) return;
    await panel.changed();
    panel.close();
  };

  return (
    <Frame title="Unsubscribe" size="small" onSubmit={submit} busy={action.pending}
      footer={<Footer submitLabel="Unsubscribe" pendingLabel="Unsubscribing…" pending={action.pending} danger />}>
      <ErrorBanner error={action.error} />
      <p className="fm-lead">Are you sure you want to unsubscribe from <strong>{feedTitle(feed)}</strong>?</p>
      <dl className="fm-impact">
        <dt>Feed</dt>
        <dd className="fm-break">{feed.url}</dd>
        <dt>Groups</dt>
        <dd>
          {feed.isSpark && <span className="fm-tag">Spark</span>}
          {memberships.length
            ? memberships.map((group) => group.title).join(", ")
            : feed.isSpark ? "" : "Kindling only"}
          {feed.isSpark && memberships.length > 0 && <span className="fm-muted"> (hidden while it is a Spark)</span>}
        </dd>
        <dt>Items</dt>
        <dd>{plural(feed.totalCount, "item")} ({feed.unreadCount.toLocaleString()} unread) will be deleted.</dd>
        <dt>Saved</dt>
        <dd className={feed.savedCount > 0 ? "fm-danger-text" : undefined}>
          {feed.savedCount > 0
            ? <>{plural(feed.savedCount, "saved item")} from this feed will be deleted too. Saved items are kept only while you are subscribed.</>
            : "No saved items."}
        </dd>
      </dl>
      <p className="fm-hint">Cancel leaves the subscription unchanged.</p>
    </Frame>
  );
}

/* ------------------------------------------------------------------ authenticate */

export function AuthFeed({ feed }: { feed: FeedDTO }) {
  const panel = usePanel();
  const action = useAction();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    setResult(null);
    const fields: Record<string, string> = {};
    if (!username.trim()) fields.username = "Enter the username for this feed.";
    if (!password) fields.password = "Enter the password for this feed.";
    const invalid = localError(fields);
    if (invalid) { action.setError(invalid); return; }
    const outcome = await action.run(async () => {
      await command("feed.authenticate", { id: feed.id, username, password });
      try {
        await command("refresh.start", { scope: "feed", id: feed.id, force: true });
        return null;
      } catch (caught) {
        return errorMessage(caught, "The retry could not be queued.");
      }
    });
    if (!outcome.ok) return;
    await panel.changed();
    if (outcome.value) {
      setResult(`The credentials were saved, but ${outcome.value.charAt(0).toLowerCase()}${outcome.value.slice(1)} Refresh the feed from the reader.`);
      return;
    }
    panel.close();
  };

  if (result) {
    return (
      <Frame title="Authentication required" size="small" footer={<Footer cancelLabel="Close" />}>
        <StatusBanner tone="warning">{result}</StatusBanner>
      </Frame>
    );
  }

  return (
    <Frame title="Authentication required" size="small" onSubmit={submit} busy={action.pending}
      subtitle={<><span title={feed.url}>{feedTitle(feed)}</span> requires a username and password.</>}
      footer={<Footer submitLabel="Authenticate" pendingLabel="Checking…" pending={action.pending} />}>
      <ErrorBanner error={action.error} />
      {feed.lastError && <p className="fm-hint">Last response: {feed.lastError}</p>}
      <TextField label="Username" value={username} autoComplete="off" spellCheck={false} data-autofocus=""
        onChange={(event) => setUsername(event.currentTarget.value)} error={fieldError(action.error, "username")} />
      <TextField label="Password" type="password" value={password} autoComplete="new-password"
        onChange={(event) => setPassword(event.currentTarget.value)} error={fieldError(action.error, "password")} />
      <p className="fm-hint">Fever saves these credentials encrypted and refreshes the feed again right away.</p>
    </Frame>
  );
}

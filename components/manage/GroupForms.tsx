"use client";
import { INHERIT_ALL, displayFrom, globalDisplay, type DisplayValues, DisplayOverrides } from "../forms/DisplayOverrides";

import { useMemo, useState } from "react";
import { ApiRequestError, command } from "@/lib/client/api";
import type { FeedDTO, GroupDTO, ReaderView } from "@/lib/contracts";
import { TabPanel, type TabSpec } from "../forms/Tabs";
import {
  Checkbox, EmptyState, ErrorBanner, Footer, Frame, MultiSelect, StatusBanner,
  TextField, byTitle, feedTitle, fieldError, localError, plural,
  useAction, usePanel, type FormError,
} from "./shared";

type GroupTab = "group" | "display";
const DISPLAY_FIELDS = ["sortOrder", "itemAllows", "itemExcerpts", "unreadCounts"];
const RESERVED = ["kindling", "sparks", "all", "hot", "saved"];

function errorTabs(error: FormError | null): Set<GroupTab> {
  const tabs = new Set<GroupTab>();
  if (error) for (const field of Object.keys(error.fields)) tabs.add(DISPLAY_FIELDS.includes(field) ? "display" : "group");
  return tabs;
}

export function feedOptions(feeds: readonly FeedDTO[]) {
  return [...feeds].sort(byTitle).map((feed) => ({ id: feed.id, label: feedTitle(feed), hint: feed.isSpark ? "(Spark)" : undefined }));
}

/* ------------------------------------------------------------------ add / edit */

export function GroupEditor({ mode, group, view }: { mode: "add" | "edit"; group?: GroupDTO; view: ReaderView }) {
  const panel = usePanel();
  const action = useAction();
  const [tab, setTab] = useState<GroupTab>("group");
  const [title, setTitle] = useState(group?.title ?? "");
  const [feedIds, setFeedIds] = useState<number[]>(group?.feedIds ?? []);
  const [display, setDisplay] = useState<DisplayValues>(mode === "edit" ? displayFrom(group) : INHERIT_ALL);
  const options = useMemo(() => feedOptions(view.feeds), [view.feeds]);
  const invalidTabs = errorTabs(action.error);
  const tabs: TabSpec<GroupTab>[] = [
    { id: "group", label: "Group", invalid: invalidTabs.has("group") },
    { id: "display", label: "Display", invalid: invalidTabs.has("display") },
  ];
  const selectedSparks = view.feeds.filter((feed) => feed.isSpark && feedIds.includes(feed.id)).length;
  const reserved = RESERVED.includes(title.trim().toLowerCase());

  const submit = async () => {
    const name = title.trim();
    const fields: Record<string, string> = {};
    if (!name) fields.title = "Enter a group name.";
    else if (name.length > 255) fields.title = "Use a name of 255 characters or fewer.";
    else if (view.groups.some((entry) => entry.id > 0 && entry.id !== group?.id && entry.title.trim().toLowerCase() === name.toLowerCase())) {
      fields.title = `A group named “${name}” already exists.`;
    }
    const invalid = localError(fields);
    if (invalid) { action.setError(invalid); setTab("group"); return; }

    const payload = { title: name, feedIds, ...display };
    const result = await action.run(async () => {
      if (mode === "edit" && group) return command("group.update", { ...payload, id: group.id });
      const response = await command("group.create", payload);
      if (response.created === false) {
        const message = `A group named “${name}” already exists.`;
        throw new ApiRequestError(message, 409, "DUPLICATE_GROUP", { title: message });
      }
      return response;
    });
    if (!result.ok) {
      const failed = errorTabs(result.error ?? null);
      if (failed.size && !failed.has(tab)) setTab(failed.has("group") ? "group" : "display");
      return;
    }
    await panel.changed();
    const groupId = mode === "add" ? result.value.id : undefined;
    // The reader listens for this and selects the new group.
    if (groupId !== undefined) window.dispatchEvent(new CustomEvent("fever:select-group", { detail: { groupId } }));
    panel.close();
  };

  return (
    <Frame title={mode === "add" ? "Create a new group" : "Edit group"} tabs={tabs} activeTab={tab} onTabChange={setTab}
      onSubmit={submit} busy={action.pending} size="wide"
      footer={<Footer submitLabel={mode === "add" ? "Add" : "Save"} pendingLabel={mode === "add" ? "Adding…" : "Saving…"} pending={action.pending} />}>
      <ErrorBanner error={action.error} />
      <TabPanel tab="group" active={tab === "group"}>
        <TextField label="Group name" value={title} required data-autofocus="" maxLength={255}
          onChange={(event) => setTitle(event.currentTarget.value)} error={fieldError(action.error, "title")}
          hint={reserved ? "This name matches one of Fever's built-in sections. It works, but can be confusing in the sidebar and in OPML files." : undefined} />
        <MultiSelect
          legend={mode === "add" ? "Add feed(s)" : "Feed(s)"}
          help="multiple"
          options={options}
          selected={feedIds}
          onChange={setFeedIds}
          emptyText="You have no feeds yet. Add feeds first, or create an empty group."
          error={fieldError(action.error, "feedIds")}
          hint={selectedSparks > 0 ? `${plural(selectedSparks, "selected feed is a Spark", "selected feeds are Sparks")}: the membership is kept but hidden until it stops being a Spark.` : undefined}
        />
      </TabPanel>
      <TabPanel tab="display" active={tab === "display"}>
        <DisplayOverrides value={display} onChange={setDisplay} inheritLabel="global default"
          inherited={globalDisplay(view.preferences)} inheritedFrom="your Display preferences" errors={action.error} />
      </TabPanel>
    </Frame>
  );
}

/* ------------------------------------------------------------------ delete */

export function DeleteGroup({ group, view }: { group: GroupDTO; view: ReaderView }) {
  const panel = usePanel();
  const action = useAction();
  const [unsubscribe, setUnsubscribe] = useState(false);
  const members = useMemo(
    () => view.feeds.filter((feed) => group.feedIds.includes(feed.id) || feed.groupIds.includes(group.id)).sort(byTitle),
    [view.feeds, group],
  );
  const groupTitles = new Map(view.groups.map((entry) => [entry.id, entry.title]));
  const removed = members.filter((feed) => !feed.isSpark);
  const keptSparks = members.filter((feed) => feed.isSpark);
  const savedLost = removed.reduce((sum, feed) => sum + feed.savedCount, 0);
  const shared = removed.filter((feed) => feed.groupIds.some((id) => id > 0 && id !== group.id));

  const submit = async () => {
    const result = await action.run(() => command("group.delete", { id: group.id, unsubscribe, confirm: true }));
    if (!result.ok) return;
    await panel.changed();
    panel.close();
  };

  return (
    <Frame title="Delete group" size={unsubscribe ? "normal" : "small"} onSubmit={submit} busy={action.pending}
      footer={<Footer submitLabel={unsubscribe ? "Delete and unsubscribe" : "Delete"} pendingLabel="Deleting…" pending={action.pending} danger />}>
      <ErrorBanner error={action.error} />
      <p className="fm-lead">Are you sure you want to delete <strong>{group.title}</strong>?</p>
      <p className="fm-hint">
        {unsubscribe
          ? "The group is deleted and you unsubscribe from the feeds listed below."
          : `Only the group is deleted. Its ${plural(members.length, "feed")} stay subscribed and remain in Kindling and any other groups.`}
      </p>
      <Checkbox label="unsubscribe from all feeds in this group" checked={unsubscribe} onChange={setUnsubscribe} />
      {unsubscribe && (
        <div className="fm-preview" aria-live="polite">
          {members.length === 0 ? (
            <EmptyState>This group has no feeds, so nothing else is removed.</EmptyState>
          ) : (
            <>
              <StatusBanner tone={savedLost > 0 ? "warning" : "info"}>
                {plural(removed.length, "feed")} will be unsubscribed
                {savedLost > 0 ? <>, deleting <strong>{plural(savedLost, "saved item")}</strong></> : ""}.
                {shared.length > 0 && <> {plural(shared.length, "of them is", "of them are")} also in other groups and will leave those groups too.</>}
                {keptSparks.length > 0 && <> {plural(keptSparks.length, "Spark")} stay subscribed and only leave this group.</>}
              </StatusBanner>
              <table className="fm-table">
                <caption className="fm-visually-hidden">Feeds affected by deleting {group.title}</caption>
                <thead>
                  <tr><th scope="col">Feed</th><th scope="col">Other groups</th><th scope="col">Saved</th><th scope="col">Result</th></tr>
                </thead>
                <tbody>
                  {members.map((feed) => {
                    const others = feed.groupIds.filter((id) => id > 0 && id !== group.id).map((id) => groupTitles.get(id)).filter(Boolean);
                    return (
                      <tr key={feed.id}>
                        <th scope="row">{feedTitle(feed)}</th>
                        <td>{others.length ? others.join(", ") : <span className="fm-muted">none</span>}</td>
                        <td className={!feed.isSpark && feed.savedCount > 0 ? "fm-danger-text" : undefined}>{feed.savedCount.toLocaleString()}</td>
                        <td>{feed.isSpark ? "Spark: stays subscribed" : "unsubscribed"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
      <p className="fm-hint">Cancel leaves the group and its feeds unchanged.</p>
    </Frame>
  );
}

/* ------------------------------------------------------------------ Sparks */

export function EditSparks({ view }: { view: ReaderView }) {
  const panel = usePanel();
  const action = useAction();
  const initial = useMemo(() => view.feeds.filter((feed) => feed.isSpark).map((feed) => feed.id), [view.feeds]);
  const [feedIds, setFeedIds] = useState<number[]>(initial);
  const options = useMemo(
    () => [...view.feeds].sort(byTitle).map((feed) => ({ id: feed.id, label: feedTitle(feed) })),
    [view.feeds],
  );
  const added = feedIds.filter((id) => !initial.includes(id)).length;
  const removed = initial.filter((id) => !feedIds.includes(id)).length;

  const submit = async () => {
    const result = await action.run(() => command("sparks.update", { feedIds }));
    if (!result.ok) return;
    await panel.changed();
    panel.close();
  };

  return (
    <Frame title="Edit Sparks" size="normal" onSubmit={submit} busy={action.pending}
      footer={(
        <Footer submitLabel="Save" pendingLabel="Saving…" pending={action.pending} disabled={!added && !removed}
          extra={<span className="fm-muted" aria-live="polite">{added || removed ? `${added} to add, ${removed} to remove` : "No changes"}</span>} />
      )}>
      <ErrorBanner error={action.error} />
      <p className="fm-hint fm-panel-intro">
        Checked feeds are Sparks: they warm up Hot but stay out of Kindling and your groups. Group memberships are kept while a feed is a Spark.
      </p>
      <MultiSelect legend="Feed(s)" help="multiple" options={options} selected={feedIds} onChange={setFeedIds}
        emptyText="You have no feeds yet." error={fieldError(action.error, "feedIds")} />
    </Frame>
  );
}

export function DeleteSparks({ view }: { view: ReaderView }) {
  const panel = usePanel();
  const action = useAction();
  const sparks = useMemo(() => view.feeds.filter((feed) => feed.isSpark).sort(byTitle), [view.feeds]);
  const saved = sparks.reduce((sum, feed) => sum + feed.savedCount, 0);

  const submit = async () => {
    const result = await action.run(() => command("sparks.delete", { confirm: true }));
    if (!result.ok) return;
    await panel.changed();
    panel.close();
  };

  if (sparks.length === 0) {
    return (
      <Frame title="Unsubscribe from Sparks" size="small" footer={<Footer cancelLabel="Close" />}>
        <EmptyState>You have no Sparks, so there is nothing to unsubscribe from.</EmptyState>
      </Frame>
    );
  }

  return (
    <Frame title="Unsubscribe from Sparks" size="normal" onSubmit={submit} busy={action.pending}
      footer={<Footer submitLabel="Unsubscribe" pendingLabel="Unsubscribing…" pending={action.pending} danger />}>
      <ErrorBanner error={action.error} />
      <p className="fm-lead">Are you sure you want to unsubscribe from all {plural(sparks.length, "feed")} in Sparks?</p>
      {saved > 0 && <StatusBanner tone="warning">This also deletes <strong>{plural(saved, "saved item")}</strong> from these feeds.</StatusBanner>}
      <ul className="fm-feed-list">
        {sparks.map((feed) => (
          <li key={feed.id}>
            {feedTitle(feed)}
            {feed.savedCount > 0 && <span className="fm-danger-text"> ({plural(feed.savedCount, "saved item")})</span>}
          </li>
        ))}
      </ul>
      <p className="fm-hint">Cancel leaves every Spark subscribed.</p>
    </Frame>
  );
}

"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { GroupDTO, Preferences } from "@/lib/contracts";
import type { CandidateGroup } from "./feedlet-candidates";

import { createFeedDraft, type FeedDraft } from "../forms/feed-draft";
import { DisplayOverrides, globalDisplay } from "../forms/DisplayOverrides";
import { TabList, TabPanel, TabScope } from "../forms/Tabs";
import "../manage/manage.css";
export interface FeedOptions extends FeedDraft { variantIndex: number; }
export function defaultFeedOptions(group: CandidateGroup, preferences: Preferences | null): FeedOptions {
  return { ...createFeedDraft(preferences), variantIndex: group.defaultIndex };
}

/** True when the user changed anything from the defaults. */
export function hasCustomOptions(options: FeedOptions, group: CandidateGroup, preferences: Preferences | null): boolean {
  const base = defaultFeedOptions(group, preferences);
  return (Object.keys(base) as Array<keyof FeedOptions>).some((key) => key !== "password" && key !== "username" && JSON.stringify(base[key]) !== JSON.stringify(options[key]));
}

type Tab = "feed" | "display" | "authentication";
const TABS = [{id: "feed", label: "Feed"}, {id: "display", label: "Display"}, {id: "authentication", label: "Authentication"}] as const;

interface FeedOptionsDialogProps {
  group: CandidateGroup;
  options: FeedOptions;
  groups: GroupDTO[];
  preferences: Preferences | null;
  onDone: (options: FeedOptions) => void;
  onCancel: () => void;
}

/**
 * Per-feed options before subscribing, matching feedlet.php's options dialog:
 * format, title, hotlinking, groups, Sparks, display overrides, credentials.
 * Native <dialog> provides the focus trap, Escape, and focus return.
 */
export function FeedOptionsDialog({ group, options, groups, preferences, onDone, onCancel }: FeedOptionsDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<FeedOptions>(options);
  const [tab, setTab] = useState<Tab>("feed");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  function update<K extends keyof FeedOptions>(key: K, value: FeedOptions[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onDone(draft);
  }

  const variant = group.variants[draft.variantIndex] ?? group.variants[0];

  return (
    <dialog
      ref={dialogRef}
      className="fp-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
    >
      <TabScope><form method="dialog" onSubmit={submit}>
        <h2 className="fp-dialog-title" id={`${id}-title`}>{group.title.length > 60 ? `${group.title.slice(0, 60)}…` : group.title}</h2>
        <TabList tabs={TABS} active={tab} onChange={setTab} />
        <TabPanel tab="feed" active={tab === "feed"}>
          {group.variants.length > 1 ? (
            <div className="fp-row">
              <label className="fp-label" htmlFor={`${id}-format`}>Format</label>
              <div className="fp-field">
                <select id={`${id}-format`} value={draft.variantIndex} onChange={(event) => update("variantIndex", Number(event.target.value))}>
                  {group.variants.map((option, index) => (
                    <option key={option.url} value={index}>
                      {option.label}{option.subscribed ? ", subscribed" : ""}{option.guessed ? ", guess" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}
          <div className="fp-row">
            <label className="fp-label" htmlFor={`${id}-title-input`}>Feed title</label>
            <div className="fp-field">
              <input
                id={`${id}-title-input`} type="text" value={draft.title} maxLength={1024}
                placeholder={variant?.title ?? group.title}
                onChange={(event) => update("title", event.target.value)}
                aria-describedby={`${id}-title-hint`}
              />
              <span className="fp-hint" id={`${id}-title-hint`}>Optional. If left blank the title provided by the feed is used.</span>
            </div>
          </div>
          <div className="fp-row">
            <span className="fp-label">Images</span>
            <div className="fp-field">
              <label className="fp-choice">
                <input type="checkbox" checked={draft.preventsHotlinking} onChange={(event) => update("preventsHotlinking", event.target.checked)} aria-describedby={`${id}-hotlink-hint`} />
                site prevents hotlinking
              </label>
              <span className="fp-hint" id={`${id}-hotlink-hint`}>Some sites refuse images loaded from other sites. Fever can load them through your installation instead.</span>
            </div>
          </div>
          <div className="fp-row">
            <span className="fp-label" id={`${id}-groups-label`}>Add to groups</span>
            <div className="fp-field">
              {groups.length ? (
                <ul className="fp-checklist" aria-labelledby={`${id}-groups-label`}>
                  {groups.map((entry) => (
                    <li key={entry.id}>
                      <label className="fp-choice fp-block">
                        <input
                          type="checkbox"
                          checked={draft.groupIds.includes(entry.id)}
                          onChange={(event) => setDraft((current) => ({
                            ...current,
                            groupIds: event.target.checked ? [...current.groupIds, entry.id] : current.groupIds.filter((value) => value !== entry.id),
                            // feedlet.php: choosing a group clears "add to Sparks".
                            isSpark: event.target.checked ? false : current.isSpark,
                          }))}
                        />
                        {entry.title}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : <span className="fp-hint">You have no groups yet. Create groups in the reader.</span>}
            </div>
          </div>
          <div className="fp-row">
            <span className="fp-label">Sparks</span>
            <div className="fp-field">
              <label className="fp-choice">
                <input type="checkbox" checked={draft.isSpark} onChange={(event) => update("isSpark", event.target.checked)} aria-describedby={`${id}-spark-hint`} />
                add to Sparks
              </label>
              <span className="fp-hint" id={`${id}-spark-hint`}>Sparks raise the temperature of links in Hot but never appear in Kindling or your groups. Group memberships are kept while a feed is a Spark.</span>
            </div>
          </div>
        </TabPanel>
        <TabPanel tab="display" active={tab === "display"}>
          <DisplayOverrides value={draft.display} onChange={(display) => update("display", display)}
            inheritLabel="use default" inherited={globalDisplay(preferences)} inheritedFrom="your preferences" />
        </TabPanel>
        <TabPanel tab="authentication" active={tab === "authentication"}>
          <p className="fp-small" style={{ margin: "0.6rem 0.75rem" }}>
            Optional. Some feeds require a username and password. If they are required but not provided, Fever asks for them when it refreshes the feed. Credentials are stored encrypted and never shown again.
          </p>
          <div className="fp-row">
            <label className="fp-label" htmlFor={`${id}-username`}>Username</label>
            <div className="fp-field">
              <input id={`${id}-username`} type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} value={draft.username} onChange={(event) => update("username", event.target.value)} />
            </div>
          </div>
          <div className="fp-row">
            <label className="fp-label" htmlFor={`${id}-password`}>Password</label>
            <div className="fp-field">
              <input id={`${id}-password`} type="password" autoComplete="new-password" value={draft.password} onChange={(event) => update("password", event.target.value)} />
            </div>
          </div>
        </TabPanel>

        <div className="fp-actions">
          <button type="button" className="fp-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="fp-btn fp-default">Done</button>
        </div>
      </form></TabScope>
    </dialog>
  );
}

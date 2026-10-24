"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { GroupDTO, Preferences } from "@/lib/contracts";
import type { CandidateGroup } from "./feedlet-candidates";

export interface FeedOptions {
  variantIndex: number;
  title: string;
  preventsHotlinking: boolean;
  groupIds: number[];
  isSpark: boolean;
  sortOrder: number;
  itemAllows: number;
  itemExcerpts: number;
  unreadCounts: number;
  username: string;
  password: string;
}

export function defaultFeedOptions(group: CandidateGroup, preferences: Preferences | null): FeedOptions {
  return {
    variantIndex: group.defaultIndex,
    title: "",
    preventsHotlinking: false,
    groupIds: [],
    isSpark: preferences?.autoSpark ?? false,
    sortOrder: -1, itemAllows: -1, itemExcerpts: -1, unreadCounts: -1,
    username: "", password: "",
  };
}

/** True when the user changed anything from the defaults. */
export function hasCustomOptions(options: FeedOptions, group: CandidateGroup, preferences: Preferences | null): boolean {
  const base = defaultFeedOptions(group, preferences);
  return (Object.keys(base) as Array<keyof FeedOptions>).some((key) => key !== "password" && key !== "username" && JSON.stringify(base[key]) !== JSON.stringify(options[key]));
}

const SORT_ORDER = ["newest first", "oldest first"];
const ITEM_ALLOWS = ["text only", "text with images", "rich content (safe)"];
type Tab = "feed" | "display" | "authentication";
const TABS: Array<[Tab, string]> = [["feed", "Feed"], ["display", "Display"], ["authentication", "Authentication"]];

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
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ feed: null, display: null, authentication: null });
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

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const index = TABS.findIndex(([key]) => key === tab);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    const key = TABS[next][0];
    setTab(key);
    tabRefs.current[key]?.focus();
  }

  const inherited = {
    sortOrder: preferences?.sortOrder ?? 0,
    itemAllows: preferences?.itemAllows ?? 1,
    itemExcerpts: preferences ? Number(preferences.itemExcerpts) : 1,
    unreadCounts: preferences ? Number(preferences.unreadCounts) : 0,
  };
  const effective = (key: "sortOrder" | "itemAllows" | "itemExcerpts" | "unreadCounts") => (draft[key] === -1 ? inherited[key] : draft[key]);
  const variant = group.variants[draft.variantIndex] ?? group.variants[0];

  function inheritToggle(key: "sortOrder" | "itemAllows" | "itemExcerpts" | "unreadCounts") {
    return (
      <label className="fp-choice fp-inherit">
        <input
          type="checkbox"
          checked={draft[key] === -1}
          onChange={(event) => update(key, event.target.checked ? -1 : inherited[key])}
        />
        use default
      </label>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className="fp-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
    >
      <form method="dialog" onSubmit={submit}>
        <h2 className="fp-dialog-title" id={`${id}-title`}>{group.title.length > 60 ? `${group.title.slice(0, 60)}…` : group.title}</h2>
        <div className="fp-tabs" role="tablist" aria-label="Feed options">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              ref={(node) => { tabRefs.current[key] = node; }}
              type="button"
              role="tab"
              id={`${id}-tab-${key}`}
              className="fp-tab"
              aria-selected={tab === key}
              aria-controls={`${id}-panel-${key}`}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={onTabKey}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="fp-tabpanel" role="tabpanel" id={`${id}-panel-feed`} aria-labelledby={`${id}-tab-feed`} hidden={tab !== "feed"}>
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
        </div>

        <div className="fp-tabpanel" role="tabpanel" id={`${id}-panel-display`} aria-labelledby={`${id}-tab-display`} hidden={tab !== "display"}>
          <div className="fp-row" role="radiogroup" aria-labelledby={`${id}-sort-label`}>
            <span className="fp-label" id={`${id}-sort-label`}>Item sort order</span>
            <div className="fp-field">
              {SORT_ORDER.map((text, value) => (
                <label key={value} className="fp-choice">
                  <input type="radio" name={`${id}-sort`} checked={effective("sortOrder") === value} onChange={() => update("sortOrder", value)} />
                  {text}
                </label>
              ))}
              {inheritToggle("sortOrder")}
            </div>
          </div>
          <div className="fp-row">
            <label className="fp-label" htmlFor={`${id}-allows`}>Item content</label>
            <div className="fp-field">
              <select id={`${id}-allows`} value={effective("itemAllows")} onChange={(event) => update("itemAllows", Number(event.target.value))}>
                {ITEM_ALLOWS.map((text, value) => <option key={value} value={value}>{text}</option>)}
              </select>
              {inheritToggle("itemAllows")}
            </div>
          </div>
          <div className="fp-row">
            <span className="fp-label">Excerpts</span>
            <div className="fp-field">
              <label className="fp-choice">
                <input type="checkbox" checked={effective("itemExcerpts") > 0} onChange={(event) => update("itemExcerpts", event.target.checked ? 1 : 0)} aria-describedby={`${id}-excerpt-hint`} />
                excerpt feed items
              </label>
              <span className="fp-hint" id={`${id}-excerpt-hint`}>Some feeds link directly to the page the author is commenting on. If excerpted you might miss their commentary.</span>
              {inheritToggle("itemExcerpts")}
            </div>
          </div>
          <div className="fp-row">
            <span className="fp-label">Counts</span>
            <div className="fp-field">
              <label className="fp-choice">
                <input type="checkbox" checked={effective("unreadCounts") > 0} onChange={(event) => update("unreadCounts", event.target.checked ? 1 : 0)} />
                show unread counts
              </label>
              {inheritToggle("unreadCounts")}
            </div>
          </div>
        </div>

        <div className="fp-tabpanel" role="tabpanel" id={`${id}-panel-authentication`} aria-labelledby={`${id}-tab-authentication`} hidden={tab !== "authentication"}>
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
        </div>

        <div className="fp-actions">
          <button type="button" className="fp-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="fp-btn fp-default">Done</button>
        </div>
      </form>
    </dialog>
  );
}

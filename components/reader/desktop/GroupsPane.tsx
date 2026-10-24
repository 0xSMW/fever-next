"use client";
import { type DragEvent, type FormEvent, useState } from "react";
import type { ReaderView, ViewState } from "@/lib/contracts";
import { readerHref } from "@/lib/client/url-state";
import { groupTitle, hotRangeLabel, hotStartLabel } from "@/lib/client/format";
import type { ReaderController } from "../controller";
import { groupUnread, groupUnreadCountsVisible, kindlingUnread, visibleGroups } from "../model";
import { Frame, HelpButton, MenuButton, type MenuItem } from "../ui";

export const FEED_DRAG_TYPE = "application/x-fever-feed";

export function readDraggedFeed(event: DragEvent): number | null {
  const raw = event.dataTransfer.getData(FEED_DRAG_TYPE);
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

interface Props {
  ctl: ReaderController;
  data: ReaderView;
  view: ViewState;
  paneFocused: boolean;
  /** Keyboard cursor row ("section-0", "group-3", ...) during delayed selection. */
  cursor: string | null;
  dragging: boolean;
  openMenu: (anchor: HTMLElement, label: string, items: MenuItem[]) => void;
}

function linkClick(event: React.MouseEvent, action: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  action();
}

function DropRow({ id, className, onDropFeed, children, label }: {
  id: string; className: string; onDropFeed: (feedId: number) => void; children: React.ReactNode; label?: string;
}) {
  const [target, setTarget] = useState(false);
  return (
    <li
      id={id}
      className={`${className}${target ? " target" : ""}`}
      aria-label={label}
      onDragOver={(event) => { if (event.dataTransfer.types.includes(FEED_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setTarget(true); } }}
      onDragLeave={() => setTarget(false)}
      onDrop={(event) => {
        setTarget(false);
        const feedId = readDraggedFeed(event);
        if (feedId) { event.preventDefault(); onDropFeed(feedId); }
      }}
    >{children}</li>
  );
}

export function GroupsPane({ ctl, data, view, paneFocused, cursor, dragging, openMenu }: Props) {
  // The field follows each new search from the view; typing edits it locally until then.
  const [query, setQuery] = useState(view.search);
  const [viewSearch, setViewSearch] = useState(view.search);
  if (viewSearch !== view.search) {
    setViewSearch(view.search);
    setQuery(view.search);
  }
  const preferences = data.preferences;
  const groups = visibleGroups(data, view);
  const kindlingCount = kindlingUnread(data.feeds);
  const selected = (key: string) => {
    if (cursor) return cursor === key;
    if (key === "section-0") return view.section === "hot";
    if (key === "group-0") return view.section === "kindling" && view.groupId === 0;
    if (key.startsWith("group-")) return view.section === "kindling" && view.groupId === Number(key.slice(6));
    if (key === "section-2") return view.section === "saved";
    if (key === "section-3") return view.section === "sparks";
    if (key === "section-4") return view.section === "search";
    return false;
  };
  const cls = (key: string, extra = "") => `${extra}${selected(key) ? " has-focus" : ""}`.trim();
  const current = (key: string) => (selected(key) && !cursor ? "page" as const : undefined);
  const showRemove = dragging && ((view.section === "kindling" && view.groupId > 0) || view.section === "sparks");

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) ctl.search(query);
    else ctl.clearSearch();
  };

  return (
    <nav id="groups" className={`box${paneFocused ? " has-focus" : ""}`} aria-label="Sections and groups">
      <ul className="box-list content">
        <li id="section-0" className={cls("section-0")}>
          <a href={readerHref({ ...view, section: "hot" })} aria-current={current("section-0")} onClick={(e) => linkClick(e, () => ctl.loadSection("hot"))}>
            <i className="icon hot" aria-hidden="true" /> Hot
          </a>
          <HelpButton topic="hot" celsius={preferences.useCelsius} />
          <span id="hot-options" className={view.section === "hot" ? "active" : undefined}>
            <button type="button" className="btn menu text" aria-haspopup="menu" aria-label={`Hot range: past ${hotRangeLabel(view.hotRange)}`}
              onClick={(e) => openMenu(e.currentTarget, "Hot range", ctl.hotRangeMenu())}>
              {hotRangeLabel(view.hotRange)}<i />
            </button>
            {" "}starting{" "}
            <button type="button" className="btn menu text" aria-haspopup="menu" aria-label={`Hot start: ${hotStartLabel(view.hotStart)}`}
              onClick={(e) => openMenu(e.currentTarget, "Hot start", ctl.hotStartMenu())}>
              {hotStartLabel(view.hotStart)}<i />
            </button>
          </span>
        </li>

        <li id="group-0" className={cls("group-0")}>
          <a
            href={readerHref({ ...view, section: "kindling", groupId: 0, feedId: 0 })}
            aria-current={current("group-0")}
            className={`group-0 ${kindlingCount ? "unread" : "read"}${groupUnreadCountsVisible(preferences, null) ? "" : " hide-unread"}`}
            onClick={(e) => linkClick(e, () => ctl.loadGroup(0))}
          >
            <i className="icon kindling" aria-hidden="true" /> Kindling <em className="unread-count">{kindlingCount}</em>
            {kindlingCount ? <span className="sr-only">, {kindlingCount} unread</span> : null}
          </a>
          <MenuButton kind="group" label="Kindling actions" onOpen={(anchor) => openMenu(anchor, "Kindling actions", ctl.groupMenu(0))} />
          <HelpButton topic="kindling" />
        </li>

        <li id="groups-scroller-container">
          <ul className="box-list" id="groups-scroller" aria-label="Groups">
            {groups.map((group) => {
              const unread = groupUnread(group, data.feeds);
              const key = `group-${group.id}`;
              return (
                <DropRow key={group.id} id={key} className={cls(key, "droppable")} onDropFeed={(feedId) => ctl.dropFeed(feedId, { kind: "group", id: group.id })}>
                  <a
                    href={readerHref({ ...view, section: "kindling", groupId: group.id, feedId: 0 })}
                    aria-current={current(key)}
                    className={`group-${group.id} ${unread ? "unread" : "read"}${groupUnreadCountsVisible(preferences, group) ? "" : " hide-unread"}`}
                    onClick={(e) => linkClick(e, () => ctl.loadGroup(group.id))}
                  >
                    {groupTitle(group)} <em className="unread-count">{unread}</em>
                    {unread ? <span className="sr-only">, {unread} unread</span> : null}
                  </a>
                  <MenuButton kind="group" label={`${groupTitle(group)} actions`} onOpen={(anchor) => openMenu(anchor, `${groupTitle(group)} actions`, ctl.groupMenu(group.id))} />
                  <button type="button" className="btn refresh" aria-label={`Refresh ${groupTitle(group)}`} title="Refresh group"
                    onClick={() => ctl.refreshGroup(group.id)}>Refresh</button>
                </DropRow>
              );
            })}
          </ul>
        </li>

        <li id="section-2" className={cls("section-2")}>
          <a href={readerHref({ ...view, section: "saved", feedId: 0 })} aria-current={current("section-2")} onClick={(e) => linkClick(e, () => ctl.loadSection("saved"))}>
            <i className="icon saved" aria-hidden="true" /> Saved <em className="saved-count">{data.savedCount}</em>
            <span className="sr-only">, {data.savedCount} saved</span>
          </a>
          <HelpButton topic="saved" />
        </li>

        <DropRow id="section-3" className={cls("section-3", "droppable")} onDropFeed={(feedId) => ctl.dropFeed(feedId, { kind: "sparks" })}>
          <a href={readerHref({ ...view, section: "sparks", feedId: 0 })} aria-current={current("section-3")} onClick={(e) => linkClick(e, () => ctl.loadSection("sparks"))}>
            <i className="icon spark" aria-hidden="true" /> Sparks
          </a>
          <MenuButton kind="group" label="Sparks actions" onOpen={(anchor) => openMenu(anchor, "Sparks actions", ctl.sparksMenu())} />
          <HelpButton topic="sparks" />
        </DropRow>

        {showRemove ? (
          <DropRow id="section-4" className="droppable remove-row" label="Drop here to remove" onDropFeed={(feedId) => ctl.dropFeed(feedId, { kind: "remove" })}>
            <div id="remove">
              <a><i className="icon trash" aria-hidden="true" /> Remove from {view.section === "sparks" ? "Sparks" : "group"}</a>
            </div>
          </DropRow>
        ) : (
          <li id="section-4" className={cls("section-4")}>
            <form id="search" role="search" onSubmit={submitSearch}>
              <a href={readerHref({ ...view, section: "search" })} aria-label="Search results" onClick={(e) => linkClick(e, () => ctl.search(query || view.search))}>
                <i className="icon search" aria-hidden="true" />
              </a>
              <span className="search q">
                <label htmlFor="q" className="sr-only">Search feeds and items</label>
                <input
                  type="search"
                  id="q"
                  name="search"
                  autoComplete="off"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") { event.preventDefault(); setQuery(""); ctl.clearSearch(); (event.target as HTMLInputElement).blur(); }
                  }}
                />
              </span>
              <button
                type="button"
                id="clear-search"
                className={`btn cancel search${query || view.search ? " clear" : ""}`}
                aria-label="Clear search"
                disabled={!query && !view.search}
                onClick={() => { setQuery(""); ctl.clearSearch(); }}
              >Clear</button>
            </form>
          </li>
        )}
      </ul>
      <Frame />
    </nav>
  );
}

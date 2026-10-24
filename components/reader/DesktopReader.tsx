"use client";
import { type MouseEvent, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { HotLinkDTO, ItemDTO } from "@/lib/contracts";
import { commandForEvent, isTypingTarget } from "@/lib/client/commands";
import { LOGO_SRC, LOGO_SRC_2X } from "@/lib/client/assets";
import { parseLocation } from "@/lib/client/url-state";
import type { OpenManagement, ReaderController, ReaderDialogRequest } from "./controller";
import { ContentPane, type BoxHandlers } from "./desktop/ContentPane";
import { FeedsPane } from "./desktop/FeedsPane";
import { GroupsPane } from "./desktop/GroupsPane";
import { RefreshStatus } from "./desktop/RefreshStatus";
import { findItem, resolveOption, visibleGroups, visibleScopeFeeds } from "./model";
import { MenuButton, MenuPopup, prefersReducedMotion, useMenu } from "./ui";
import type { FeverHistoryState, ReaderStore } from "./useReader";

interface Props {
  store: ReaderStore;
  ctl: ReaderController;
  openManagement: OpenManagement;
  openDialog: (request: ReaderDialogRequest) => void;
  /** A modal (management or reader dialog) is open; reader shortcuts pause. */
  modalOpen: boolean;
}

const AUTO_READ_LINE = 64;

export function DesktopReader({ store, ctl, openManagement, openDialog, modalOpen }: Props) {
  const { view, data, list } = store;
  const { menu, open: openMenu, close: closeMenu } = useMenu();
  const [dragging, setDragging] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sourceFocus, setSourceFocus] = useState(-1);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());
  const programmaticUntil = useRef(0);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollY = useRef(0);
  const focus = view.hasFocus;

  const preferences = data?.preferences;
  const boxIds = useMemo(() => (view.section === "hot" ? list.links.map((l) => `link-${l.id}`) : list.items.map((i) => `item-${i.id}`)), [list, view.section]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /* ---------------- scrolling ---------------- */

  const scrollToY = useCallback((y: number) => {
    programmaticUntil.current = Date.now() + 900;
    window.scrollTo({ top: Math.max(0, y), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  // A new first page starts with collapsed boxes and no source focus.
  const [pageLoadId, setPageLoadId] = useState(list.loadId);
  if (pageLoadId !== list.loadId) {
    setPageLoadId(list.loadId);
    if (list.loadId) {
      setExpanded({});
      setSourceFocus(-1);
    }
  }

  // New first page: restore the remembered position or return to the top.
  const restorePosition = useEffectEvent(() => {
    const y = store.takeRestoreScroll();
    programmaticUntil.current = Date.now() + 600;
    requestAnimationFrame(() => window.scrollTo(0, y ?? 0));
    const panes = (window.history.state as { fever?: FeverHistoryState } | null)?.fever?.panes;
    if (y !== null && panes) {
      requestAnimationFrame(() => {
        const groups = document.getElementById("groups-scroller");
        const feeds = document.getElementById("feeds-scroller");
        if (groups && panes.groups !== undefined) groups.scrollTop = panes.groups;
        if (feeds && panes.feeds !== undefined) feeds.scrollTop = panes.feeds;
      });
    }
  });
  useEffect(() => {
    if (list.loadId) restorePosition();
  }, [list.loadId]);

  // Remember pane scroll offsets in the current history entry.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onPaneScroll = (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.id !== "groups-scroller" && target.id !== "feeds-scroller") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const state = (window.history.state ?? {}) as { fever?: FeverHistoryState };
        if (!state.fever) return;
        const panes = { ...(state.fever.panes ?? {}), [target.id === "groups-scroller" ? "groups" : "feeds"]: target.scrollTop };
        window.history.replaceState({ ...state, fever: { ...state.fever, panes } }, "", window.location.href);
      }, 300);
    };
    document.addEventListener("scroll", onPaneScroll, true);
    return () => { document.removeEventListener("scroll", onPaneScroll, true); if (timer) clearTimeout(timer); };
  }, []);

  /**
   * reader.js scroll handler: load the next page near the end; mark items
   * read once their whole box has passed the 64px line (user scrolling only).
   * The topmost remaining box receives focus without being marked read.
   */
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const down = y > lastScrollY.current;
      lastScrollY.current = y;
      if (down && y + window.innerHeight * 2 >= document.documentElement.scrollHeight && list.hasMore && !store.pageLoading) void store.loadNextPage();
      if (Date.now() < programmaticUntil.current || !preferences?.autoRead) return;
      const boxes = document.querySelectorAll<HTMLElement>("#content-container .box.item, #content-container .box.link");
      const passed: number[] = [];
      for (const box of Array.from(boxes)) {
        const rect = box.getBoundingClientRect();
        if (rect.bottom > AUTO_READ_LINE) {
          if (focus !== box.id) store.setFocus(box.id);
          break;
        }
        if (box.id.startsWith("item-")) passed.push(Number(box.id.slice(5)));
      }
      if (passed.length) store.markRead(passed);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [focus, list.hasMore, preferences?.autoRead, store]);

  /* ---------------- focus and content ---------------- */

  const boxElement = (boxId: string) => document.getElementById(boxId);

  const focusBox = useCallback((boxId: string, opts: { scroll?: boolean; read?: boolean } = {}) => {
    store.setFocus(boxId);
    setSourceFocus(-1);
    if (opts.read && preferences?.autoRead && boxId.startsWith("item-")) store.markRead([Number(boxId.slice(5))]);
    if (opts.scroll) {
      const element = boxElement(boxId);
      if (element) scrollToY(window.scrollY + element.getBoundingClientRect().top - 16);
    }
  }, [preferences?.autoRead, scrollToY, store]);

  const isFull = useCallback((boxId: string) => {
    if (expanded[boxId] !== undefined) return expanded[boxId];
    if (!data || boxId.startsWith("link-")) return false;
    const item = list.items.find((row) => `item-${row.id}` === boxId);
    const feed = item ? data.feeds.find((row) => row.id === item.feedId) : undefined;
    return resolveOption("itemExcerpts", data.preferences, view, data.groups, feed) === 0;
  }, [data, expanded, list.items, view]);

  const toggleContent = useCallback((boxId: string, itemId: number | null) => {
    if (boxId.startsWith("link-") && !itemId) return;
    const next = !isFull(boxId);
    setExpanded((previous) => ({ ...previous, [boxId]: next }));
    if (itemId && boxId.startsWith("item-")) store.markRead([itemId]);
    const element = boxElement(boxId);
    if (element) {
      const top = element.getBoundingClientRect().top;
      if (top < 0) scrollToY(window.scrollY + top - 16);
    }
  }, [isFull, scrollToY, store]);

  /** reader.js onBoxClick. */
  const onBoxClick = useCallback((boxId: string, event: MouseEvent, itemId: number | null) => {
    const target = event.target as HTMLElement;
    if (focus !== boxId) { store.setFocus(boxId); setSourceFocus(-1); }
    const onControl = target.closest("a, button, input, select, textarea, video, audio, summary, .inline-feed, .state");
    if (boxId.startsWith("item-") && itemId && !target.closest(".btn, .inline-feed, .state")) store.markRead([itemId]);
    const selecting = Boolean(window.getSelection()?.toString());
    if (preferences?.toggleClick && !onControl && !selecting) toggleContent(boxId, itemId);
  }, [focus, preferences?.toggleClick, store, toggleContent]);

  const handlers: BoxHandlers = useMemo(() => ({
    onBoxClick,
    onToggleContent: toggleContent,
    onToggleSave: (itemId: number) => store.toggleSave(itemId),
    onBlacklist: (link: HotLinkDTO) => ctl.blacklistLink(link),
    onOpened: (itemId: number) => store.markRead([itemId]),
    openMenu,
    onDragState: setDragging,
  }), [ctl, onBoxClick, openMenu, store, toggleContent]);

  /* ---------------- history ---------------- */

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const state = (event.state as { fever?: FeverHistoryState } | null)?.fever;
      if (state?.view) store.navigate(state.view, { history: "none", restoreScroll: state.scrollY ?? 0 });
      else {
        const parsed = parseLocation(window.location.search);
        store.navigate(parsed.view, { history: "none", restoreScroll: 0 });
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [store]);

  /* ---------------- keyboard ---------------- */

  const groupRows = useMemo(() => {
    if (!data) return [];
    return ["section-0", "group-0", ...visibleGroups(data, view).map((g) => `group-${g.id}`), "section-2", "section-3", "section-4"];
  }, [data, view]);
  const feedRows = useMemo(() => {
    if (!data) return [];
    return ["feed-0", ...visibleScopeFeeds(data, view, list.items).map((f) => `feed-${f.id}`)];
  }, [data, list.items, view]);

  const selectedRow = useCallback((pane: "groups" | "feeds") => {
    if (pane === "feeds") return `feed-${view.feedId}`;
    switch (view.section) {
      case "hot": return "section-0";
      case "saved": return "section-2";
      case "sparks": return "section-3";
      case "search": return "section-4";
      default: return `group-${view.groupId}`;
    }
  }, [view]);

  const activateRow = useCallback((row: string) => {
    const [kind, raw] = row.split("-");
    const id = Number(raw);
    if (kind === "feed") ctl.loadFeed(id);
    else if (kind === "group") ctl.loadGroup(id);
    else if (row === "section-0") ctl.loadSection("hot");
    else if (row === "section-2") ctl.loadSection("saved");
    else if (row === "section-3") ctl.loadSection("sparks");
    else if (row === "section-4") ctl.search(view.search);
  }, [ctl, view.search]);

  const moveCursor = useCallback((pane: "groups" | "feeds", delta: number) => {
    const rows = pane === "groups" ? groupRows : feedRows;
    if (!rows.length) return;
    const currentRow = cursor ?? selectedRow(pane);
    const index = rows.indexOf(currentRow);
    const next = rows[((index === -1 ? 0 : index + delta) + rows.length) % rows.length];
    setCursor(next);
    document.getElementById(next)?.scrollIntoView({ block: "nearest" });
    if (cursorTimer.current) clearTimeout(cursorTimer.current);
    cursorTimer.current = setTimeout(() => { setCursor(null); activateRow(next); }, 500);
  }, [activateRow, cursor, feedRows, groupRows, selectedRow]);

  useEffect(() => () => { if (cursorTimer.current) clearTimeout(cursorTimer.current); }, []);

  const firstVisibleBox = useCallback(() => boxIds.find((id) => (boxElement(id)?.getBoundingClientRect().bottom ?? 0) > AUTO_READ_LINE) ?? boxIds[0], [boxIds]);

  /** reader.js loadNextUnread: first unread feed (or group) after the current one. */
  const loadNextUnread = useCallback(() => {
    if (!data) return false;
    if (view.showFeeds && view.section !== "hot") {
      const feed = visibleScopeFeeds(data, view, list.items).find((row) => row.unreadCount > 0 && row.id !== view.feedId);
      if (feed) { ctl.loadFeed(feed.id); return true; }
    }
    const group = visibleGroups(data, view).find((row) => row.id !== view.groupId && data.feeds.some((feed) => !feed.isSpark && feed.unreadCount > 0 && (feed.groupIds.includes(row.id) || row.feedIds.includes(feed.id))));
    if (group) { ctl.loadGroup(group.id); return true; }
    return false;
  }, [ctl, data, list.items, view]);

  const focusedItem = useCallback((): ItemDTO | undefined => {
    if (focus.startsWith("item-")) return list.items.find((item) => `item-${item.id}` === focus);
    if (focus.startsWith("link-")) {
      const link = list.links.find((row) => `link-${row.id}` === focus);
      if (link && link.isItem && link.isLocal) return findItem(list.items, list.links, link.itemId);
    }
    return undefined;
  }, [focus, list.items, list.links]);

  const stepItem = useCallback((previous: boolean, paging: boolean) => {
    const index = boxIds.indexOf(focus);
    if (index === -1) {
      const first = firstVisibleBox();
      if (first) focusBox(first, { scroll: true, read: true });
      return;
    }
    const element = boxElement(focus);
    if (paging && element) {
      const rect = element.getBoundingClientRect();
      if (!previous && rect.bottom > window.innerHeight - 16) { scrollToY(window.scrollY + window.innerHeight - 48); return; }
      if (previous && rect.top < 0) { scrollToY(window.scrollY - window.innerHeight + 48); return; }
    }
    const target = boxIds[index + (previous ? -1 : 1)];
    if (target) { focusBox(target, { scroll: true, read: true }); return; }
    if (!previous) {
      if (list.hasMore) void store.loadNextPage();
      else loadNextUnread();
    }
  }, [boxIds, firstVisibleBox, focus, focusBox, list.hasMore, loadNextUnread, scrollToY, store]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalOpen || menu || !data) return;
      if (isTypingTarget(event.target)) return;
      const active = document.activeElement;
      const onControl = active instanceof HTMLElement && active !== document.body && active.matches("a[href], button, summary, [role='menuitem']");

      // User-defined sharing services take priority when an item is focused.
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.length === 1) {
        const item = focusedItem();
        const service = item ? data.preferences.services.find((s) => s.key && s.key.toLowerCase() === event.key.toLowerCase()) : undefined;
        if (item && service) { event.preventDefault(); void ctl.shareItem(item, service); return; }
      }

      const id = commandForEvent(event);
      if (!id) return;
      if ((id === "toggle-content" || id === "page-next" || id === "page-previous") && onControl) return;
      const inPane = focus === "groups" || focus === "feeds";
      let handled = true;
      switch (id) {
        case "section-hot": ctl.loadSection("hot"); break;
        case "section-kindling": ctl.loadGroup(0); break;
        case "section-saved": ctl.loadSection("saved"); break;
        case "section-sparks": ctl.loadSection("sparks"); break;
        case "section-search": ctl.search(view.search); break;
        case "focus-search": document.getElementById("q")?.focus(); break;
        case "escape":
          if (view.search || view.section === "search") ctl.clearSearch();
          else handled = false;
          break;
        case "undo": void store.undoRecentlyRead(); break;
        case "mark-active-read": ctl.markActiveRead(); break;
        case "mark-all-read": ctl.markAllRead(); break;
        case "refresh-all": void store.startRefresh({ scope: "all" }); break;
        case "refresh-active": ctl.refreshActive(); break;
        case "save": {
          const item = focusedItem();
          if (item) store.toggleSave(item.id); else handled = false;
          break;
        }
        case "new-feed": openManagement("add-feed"); break;
        case "new-group": openManagement("add-group"); break;
        case "toggle-read": ctl.toggleRead(); break;
        case "toggle-feeds": ctl.toggleFeeds(); break;
        case "preferences": openManagement("preferences"); break;
        case "help": openDialog({ kind: "keyboard" }); break;
        case "blacklist-page": openManagement("blacklist"); break;
        case "blacklist-link": {
          const link = list.links.find((row) => `link-${row.id}` === focus);
          if (link) ctl.blacklistLink(link); else handled = false;
          break;
        }
        case "edit-active": ctl.editActive(); break;
        case "toggle-content":
          if (focus.startsWith("item-")) toggleContent(focus, Number(focus.slice(5)));
          else if (focus.startsWith("link-")) {
            const link = list.links.find((row) => `link-${row.id}` === focus);
            if (link && link.isItem && link.isLocal) toggleContent(focus, link.itemId); else handled = false;
          } else handled = false;
          break;
        case "open": {
          if (focus.startsWith("link-")) {
            const link = list.links.find((row) => `link-${row.id}` === focus);
            const source = link && sourceFocus >= 0 ? link.sources[sourceFocus] : undefined;
            if (source) ctl.openItem(source.url, source.id);
            else if (link) ctl.openItem(link.url, link.isItem ? link.itemId : undefined);
            else handled = false;
          } else {
            const item = focusedItem();
            if (item) ctl.openItem(item.url, item.id); else handled = false;
          }
          break;
        }
        case "visit-site":
        case "visit-site-read": {
          const item = focusedItem();
          const link = list.links.find((row) => `link-${row.id}` === focus);
          const feedId = item?.feedId ?? (link && link.isItem && link.isLocal ? link.feedId : 0) ?? 0;
          const target = feedId || (focus === "feeds" ? view.feedId : 0);
          if (target) ctl.visitFeed(target, id === "visit-site-read"); else handled = false;
          break;
        }
        case "pane-left":
        case "pane-right": {
          const right = id === "pane-right";
          const noFeeds = view.section === "hot" || !view.showFeeds;
          if (focus === "groups") {
            if (!right || noFeeds) { const first = firstVisibleBox(); if (first) focusBox(first, { read: true }); }
            else store.setFocus("feeds");
          } else if (focus === "feeds") {
            if (!right) store.setFocus("groups");
            else { const first = firstVisibleBox(); if (first) focusBox(first, { read: true }); }
          } else if (right) {
            const link = list.links.find((row) => `link-${row.id}` === focus);
            const source = link && sourceFocus >= 0 ? link.sources[sourceFocus] : undefined;
            const item = focusedItem();
            if (source) ctl.openItem(source.url, source.id);
            else if (link) ctl.openItem(link.url, link.isItem ? link.itemId : undefined);
            else if (item) ctl.openItem(item.url, item.id);
          } else store.setFocus(noFeeds ? "groups" : "feeds");
          break;
        }
        case "list-up":
        case "list-down":
          if (inPane) moveCursor(focus as "groups" | "feeds", id === "list-up" ? -1 : 1);
          else handled = false;
          break;
        case "next-item":
        case "previous-item":
          if (inPane) moveCursor(focus as "groups" | "feeds", id === "previous-item" ? -1 : 1);
          else stepItem(id === "previous-item", false);
          break;
        case "page-next":
        case "page-previous":
          stepItem(id === "page-previous", true);
          break;
        case "source-up":
        case "source-down": {
          const link = view.section === "hot" ? list.links.find((row) => `link-${row.id}` === focus) : undefined;
          if (!link || !link.sources.length) { handled = false; break; }
          const up = id === "source-up";
          const next = sourceFocus === -1 ? (up ? link.sources.length - 1 : 0) : sourceFocus + (up ? -1 : 1);
          setSourceFocus(next >= 0 && next < link.sources.length ? next : -1);
          break;
        }
        default: handled = false;
      }
      if (handled) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [ctl, data, firstVisibleBox, focus, focusBox, focusedItem, list.links, menu, modalOpen, moveCursor, openDialog, openManagement, sourceFocus, stepItem, store, toggleContent, view]);

  // Keep a keyboard-focused Hot source visible.
  useEffect(() => {
    if (sourceFocus < 0) return;
    const row = document.querySelector<HTMLElement>(`#${focus} .source-list li.has-focus`);
    if (!row) return;
    const rect = row.getBoundingClientRect();
    if (rect.bottom > window.innerHeight || rect.top < 0) scrollToY(window.scrollY + rect.top - window.innerHeight / 3);
  }, [focus, scrollToY, sourceFocus]);

  if (!data) return null;
  const classes = [
    "fever-desktop",
    view.showFeeds ? "show-feeds" : "",
    view.section === "hot" ? "hot" : "",
    data.preferences.layout ? "fluid" : "",
    dragging ? "dragging" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <a className="skip-link" href="#content-container">Skip to articles</a>
      <div id="top" />
      <div id="fixed">
        <div className="container">
          <div id="fever" className={store.loading || store.pageLoading ? "loading" : undefined}>
            <span id="logo">
              {/* eslint-disable-next-line @next/next/no-img-element -- fixed-size preserved source asset with its own 2x file */}
              <img src={LOGO_SRC} srcSet={`${LOGO_SRC} 1x, ${LOGO_SRC_2X} 2x`} width={50} height={17} alt="Fever°" />
            </span>
            <MenuButton kind="action" label="Fever actions" onOpen={(anchor) => openMenu(anchor, "Fever actions", ctl.actionMenu())} />
            {store.loading ? <span className="sr-only" role="status">Loading</span> : null}
          </div>
          <div id="fluid">
            <div id="groups-container">
              <GroupsPane ctl={ctl} data={data} view={view} paneFocused={focus === "groups"} cursor={cursor && cursor.startsWith("feed-") ? null : cursor} dragging={dragging} openMenu={openMenu} />
              <RefreshStatus
                data={data}
                job={store.refreshJob}
                error={store.refreshError}
                now={now}
                notice={store.notice}
                freshCount={store.pendingFresh ? (view.section === "hot"
                  ? store.pendingFresh.links.filter((l) => !list.links.some((x) => x.id === l.id)).length
                  : store.pendingFresh.items.filter((i) => !list.items.some((x) => x.id === i.id)).length) : 0}
                onRefresh={() => void store.startRefresh({ scope: "all" })}
                onCancel={() => void store.cancelRefresh()}
                onShowFresh={store.showFresh}
                onDismissNotice={() => store.setNotice(null)}
              />
            </div>
            {view.section !== "hot" && view.showFeeds ? (
              <FeedsPane ctl={ctl} data={data} view={view} items={list.items} paneFocused={focus === "feeds"}
                cursor={cursor && cursor.startsWith("feed-") ? cursor : null} openMenu={openMenu} onDragState={setDragging} />
            ) : null}
          </div>
        </div>
      </div>

      <div className="container">
        <main id="content-container" tabIndex={-1} aria-label="Articles" aria-busy={store.loading}
          className={!list.hasMore && boxIds.length ? "maxed" : undefined}>
          <ContentPane
            ctl={ctl}
            store={store}
            data={data}
            view={view}
            list={list}
            focus={focus}
            sourceFocus={sourceFocus}
            expanded={expanded}
            handlers={handlers}
            onManage={(kind, feed) => openManagement(kind, feed ? { feed } : undefined)}
            onFocusSearch={() => document.getElementById("q")?.focus()}
          />
        </main>
      </div>

      {menu ? <MenuPopup request={menu} onClose={closeMenu} /> : null}
    </div>
  );
}

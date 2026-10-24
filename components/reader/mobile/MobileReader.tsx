"use client";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ViewState } from "@/lib/contracts";
import { SECTION_LABELS, feedTitle, groupTitle } from "@/lib/client/format";
import { type MobileScreen, parseLocation, readerHref } from "@/lib/client/url-state";
import type { OpenManagement, ReaderController } from "../controller";
import { openExternal } from "../external";
import { findItem } from "../model";
import type { ReaderStore } from "../useReader";
import { scopedList, viewKey } from "../useReader";
import { TextButton } from "../ui";
import {
  ArticleScreen, FeedsScreen, GroupsScreen, HotScreen, ItemsScreen, MobilePreferences, type MobileSettings, WebviewScreen,
} from "./screens";

import { readFeverHistory, writeFeverHistory, type FeverHistoryState, type MobileRoute } from "@/lib/client/reader-history";
export type { MobileRoute } from "@/lib/client/reader-history";
type Screen = MobileRoute["screen"];
type MobileHistory = FeverHistoryState & { route: MobileRoute };

const RANK: Record<Screen, number> = { groups: 0, feeds: 1, items: 2, hot: 2, article: 3, webview: 4 };

interface Props {
  store: ReaderStore;
  ctl: ReaderController;
  openManagement: OpenManagement;
  initialRoute: { screen: MobileScreen | null; itemId: number };
  settings: MobileSettings;
  onSettings: (next: MobileSettings) => void;
  onDesktop: () => void;
  onLogout: () => void;
}

function readState(): MobileHistory | null {
  const state = readFeverHistory();
  return state?.route ? state as MobileHistory : null;
}

export function MobileReader({ store, ctl, openManagement, initialRoute, settings, onSettings, onDesktop, onLogout }: Props) {
  const { view, data } = store;
  // iphone.js loadRemote drew a screen only when its response arrived. The view
  // changes at once on navigation, so rows of the previous scope are hidden
  // (the screen shows Loading…) until the list key matches the view again.
  const currentKey = viewKey(view);
  const list = scopedList(store.list, view);
  const [route, setRoute] = useState<MobileRoute>(() => ({
    screen: initialRoute.screen ?? "groups",
    itemId: initialRoute.itemId, linkId: 0, url: "",
  }));
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [nextPending, setNextPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The committed route, for event handlers and effects. Layout effects run before
  // passive effects and before the browser can deliver input to the new screen.
  const routeRef = useRef(route);
  useLayoutEffect(() => { routeRef.current = route; }, [route]);
  const restoreY = useRef<number | null>(null);

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);

  // Seed the first history entry so Back works inside the app.
  const seedHistory = useEffectEvent(() => {
    if (!readState()) {
      writeFeverHistory("replace", { view: store.view, route: routeRef.current, depth: 0 }, readerHref(store.view, { screen: routeRef.current.screen === "webview" ? null : routeRef.current.screen, itemId: routeRef.current.itemId }));
    }
  });
  useEffect(() => { seedHistory(); }, []);

  const hrefFor = useCallback((target: ViewState, next: MobileRoute) => readerHref(target, {
    screen: next.screen === "webview" ? "article" : next.screen,
    itemId: next.itemId || undefined,
  }), []);

  /** Rendered unread rows of the items screen (back-out scope). */
  const renderedUnread = useCallback(() => list.items.filter((item) => !item.readAt && !item.isSaved).map((item) => item.id), [list.items]);

  /** iphone.js markAllVisibleItemsAsRead: leaving a Kindling/Sparks item list. */
  const backOut = useCallback((from: MobileRoute, to: MobileRoute) => {
    if (from.screen !== "items" || RANK[to.screen] >= RANK.items) return;
    if (!data?.preferences.mobileReadOnBackOut) return;
    if (view.section !== "kindling" && view.section !== "sparks") return;
    const ids = renderedUnread();
    if (ids.length) store.markRead(ids, true);
  }, [data?.preferences.mobileReadOnBackOut, renderedUnread, store, view.section]);

  const push = useCallback((next: MobileRoute, patch?: Partial<ViewState>) => {
    const current = readState();
    const depth = (current?.depth ?? 0) + 1;
    writeFeverHistory("replace", { ...(current ?? { view: store.view, route: routeRef.current, depth: 0 }), scrollY: window.scrollY }, window.location.href);
    const target = patch ? { ...store.view, ...patch } : store.view;
    if (patch) store.navigate(patch, { history: "none" });
    writeFeverHistory("push", { view: target, route: next, depth }, hrefFor(target, next));
    setRoute(next);
    restoreY.current = 0;
  }, [hrefFor, store]);

  /** Parent screen for in-app Back when there is no history to pop. */
  const parentOf = useCallback((from: MobileRoute): MobileRoute => {
    const base = { itemId: 0, linkId: 0, url: "" };
    switch (from.screen) {
      case "webview": return { ...from, screen: from.itemId ? "article" : view.section === "hot" ? "hot" : "items", url: "" };
      case "article": return { ...base, screen: view.section === "hot" ? "hot" : "items" };
      case "items": return { ...base, screen: settings.showFeeds && view.section !== "hot" ? "feeds" : "groups" };
      default: return { ...base, screen: "groups" };
    }
  }, [settings.showFeeds, view.section]);

  const goBack = useCallback(() => {
    const current = readState();
    if (current && (current.depth ?? 0) > 0) { window.history.back(); return; }
    const from = routeRef.current;
    const to = parentOf(from);
    backOut(from, to);
    const patch: Partial<ViewState> | undefined = from.screen === "items" && to.screen === "feeds" ? { feedId: 0 } : undefined;
    if (patch) store.navigate(patch, { history: "none" });
    const target = patch ? { ...store.view, ...patch } : store.view;
    writeFeverHistory("replace", { view: target, route: to, depth: 0 }, hrefFor(target, to));
    setRoute(to);
    if (to.screen === "groups") void store.softReload(false);
  }, [backOut, hrefFor, parentOf, store]);

  // Browser Back/Forward.
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const entry = readFeverHistory(event.state);
      const from = routeRef.current;
      let to: MobileRoute;
      let targetView: Partial<ViewState>;
      if (entry?.route) { to = entry.route; targetView = entry.view; }
      else {
        const parsed = parseLocation(window.location.search);
        to = { screen: parsed.screen ?? "groups", itemId: parsed.itemId, linkId: 0, url: "" };
        targetView = parsed.view;
      }
      backOut(from, to);
      const merged = { ...store.view, ...targetView };
      if (viewKey(merged) !== viewKey(store.view)) store.navigate(targetView, { history: "none", restoreScroll: entry?.scrollY ?? 0 });
      else if (to.screen === "groups" && RANK[from.screen] > 0) void store.softReload(false);
      restoreY.current = entry?.scrollY ?? 0;
      setRoute(to);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [backOut, store]);

  // Restore scroll after a screen change. A list screen whose rows are still
  // loading for this view waits for them, so the position applies to its own rows.
  const rowsPending = (route.screen === "items" || route.screen === "hot") && store.loading && store.list.key !== currentKey;
  useEffect(() => {
    const y = restoreY.current;
    if (y === null || rowsPending) return;
    restoreY.current = null;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }, [route, rowsPending]);

  /* ---------------- navigation actions ---------------- */

  const loadSection = (section: "hot" | "saved" | "sparks") => {
    if (section === "hot") push({ screen: "hot", itemId: 0, linkId: 0, url: "" }, { section: "hot", feedId: 0 });
    else push({ screen: settings.showFeeds ? "feeds" : "items", itemId: 0, linkId: 0, url: "" }, { section, feedId: 0 });
  };
  const loadGroup = useCallback((groupId: number) => push({ screen: settings.showFeeds ? "feeds" : "items", itemId: 0, linkId: 0, url: "" }, { section: "kindling", groupId, feedId: 0 }), [push, settings.showFeeds]);

  // GroupEditor dispatches this after a new group is created: open it like a tap on the groups screen.
  // ReaderShell ignores the event in the compact layout, so this is the only navigation.
  useEffect(() => {
    const onSelectGroup = (event: Event) => {
      const groupId = (event as CustomEvent<{ groupId?: unknown }>).detail?.groupId;
      if (typeof groupId === "number" && Number.isSafeInteger(groupId) && groupId > 0) loadGroup(groupId);
    };
    window.addEventListener("fever:select-group", onSelectGroup);
    return () => window.removeEventListener("fever:select-group", onSelectGroup);
  }, [loadGroup]);

  const loadSearch = (term: string) => {
    const value = term.trim();
    if (!value) return;
    push({ screen: settings.showFeeds ? "feeds" : "items", itemId: 0, linkId: 0, url: "" }, { section: "search", search: value, feedId: 0, previous: view.section === "search" ? view.previous : view.section });
  };
  const loadFeed = (feedId: number) => push({ screen: "items", itemId: 0, linkId: 0, url: "" }, { feedId });

  const openItem = (itemId: number, linkId = 0) => {
    store.markRead([itemId]);
    push({ screen: "article", itemId, linkId, url: "" });
  };

  /** View in app when allowed; otherwise a normal external navigation. */
  const openUrl = useCallback((url: string, itemId?: number) => {
    if (itemId) store.markRead([itemId]);
    let embeddable = false;
    try {
      const target = new URL(url);
      embeddable = /^https?:$/.test(target.protocol) && target.origin !== window.location.origin;
    } catch { embeddable = false; }
    if (data?.preferences.mobileViewInApp && embeddable) {
      push({ screen: "webview", itemId: routeRef.current.screen === "article" ? routeRef.current.itemId : 0, linkId: routeRef.current.linkId, url });
      return true;
    }
    if (!openExternal(url, data?.preferences)) store.setNotice({ kind: "error", text: "This link is not a web address Fever can open." });
    return true;
  }, [data?.preferences, push, store]);

  /* ---------------- read on scroll + paging ---------------- */

  useEffect(() => {
    if (route.screen !== "items" && route.screen !== "hot") return;
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y === lastY) return;
      lastY = y;
      if (y + window.innerHeight >= document.documentElement.scrollHeight - 200 && list.hasMore && !store.pageLoading) void store.loadNextPage();
      if (route.screen !== "items" || !data?.preferences.mobileReadOnScroll) return;
      const rows = document.querySelectorAll<HTMLElement>("#items ul.list li.unread");
      const ids: number[] = [];
      for (const row of Array.from(rows)) {
        const top = row.getBoundingClientRect().top + y;
        // iphone.js: 75% of the row has scrolled above the top of the viewport.
        if (top + Math.floor(row.offsetHeight * 0.75) <= y) ids.push(Number(row.id.slice(5)));
        else break;
      }
      if (ids.length) store.markRead(ids);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [data?.preferences.mobileReadOnScroll, list.hasMore, route.screen, store]);

  /* ---------------- article ---------------- */

  const routeStandalone = store.article.itemId === route.itemId ? store.article : null;
  const articleItem = useMemo(() => {
    if (route.screen !== "article" && route.screen !== "webview") return null;
    return findItem(list.items, list.links, route.itemId, routeStandalone?.item) ?? null;
  }, [list.items, list.links, route.itemId, route.screen, routeStandalone]);

  const loadArticle = store.loadArticle;
  const cancelArticle = store.cancelArticle;
  useEffect(() => {
    if (route.screen !== "article" || !route.itemId || store.loading) return;
    void loadArticle(route.itemId);
    return cancelArticle;
  }, [route.itemId, route.screen, store.loading, loadArticle, cancelArticle]);

  const replaceArticle = useCallback((itemId: number) => {
    store.markRead([itemId]);
    const next = { ...routeRef.current, itemId };
    writeFeverHistory("replace", { view: store.view, route: next, depth: readState()?.depth ?? 0 }, hrefFor(store.view, next));
    setRoute(next);
    window.scrollTo(0, 0);
  }, [hrefFor, store]);

  const siblings = useMemo(() => {
    if (!articleItem) return [] as number[];
    if (view.section === "hot" && route.linkId) {
      const link = list.links.find((row) => row.id === route.linkId);
      return link ? link.sources.map((source) => source.id) : [articleItem.id];
    }
    return list.items.map((item) => item.id);
  }, [articleItem, list.items, list.links, route.linkId, view.section]);
  const index = articleItem ? siblings.indexOf(articleItem.id) : -1;
  /** A Next press that is waiting for the following page: list length, scope and article it started from. */
  const pendingNextFrom = useRef<{ from: number; key: string; itemId: number } | null>(null);

  const stepArticle = useCallback(async (delta: number) => {
    const target = siblings[index + delta];
    if (target) { replaceArticle(target); return; }
    if (delta > 0 && list.hasMore && view.section !== "hot") {
      setNextPending(true);
      const before = { from: list.items.length, key: currentKey, itemId: routeRef.current.itemId };
      const ok = await store.loadNextPage();
      setNextPending(false);
      // loadNextPage fails after any navigation; the reader may also have left this article.
      if (!ok || routeRef.current.screen !== "article" || routeRef.current.itemId !== before.itemId) return;
      // The list state updates asynchronously; read the next ID on the following render.
      pendingNextFrom.current = before;
    }
  }, [currentKey, index, list.hasMore, list.items.length, replaceArticle, siblings, store, view.section]);

  useEffect(() => {
    const pending = pendingNextFrom.current;
    if (pending === null) return;
    // A page for another scope or article, or one that arrives after leaving the article, opens nothing.
    if (route.screen !== "article" || pending.key !== currentKey || pending.itemId !== route.itemId) {
      pendingNextFrom.current = null;
      return;
    }
    const from = pending.from;
    if (list.items.length > from) {
      pendingNextFrom.current = null;
      const next = list.items[from];
      if (next) {
        replaceArticle(next.id);
      }
    }
  }, [currentKey, list.items, replaceArticle, route.itemId, route.screen]);

  /* ---------------- titles ---------------- */

  if (!data) return null;
  const scopeName = view.section === "kindling" ? (view.groupId ? groupTitle(data.groups.find((g) => g.id === view.groupId)) : "Kindling") : SECTION_LABELS[view.section];
  const scopeClass = view.section === "kindling" && view.groupId ? "" : view.section;
  const feed = view.feedId ? data.feeds.find((row) => row.id === view.feedId) : undefined;
  // mobile/reader/items.php titles the screen with the selected feed, which for
  // feed 0 is the "All items" row tapped on the feeds screen; the back button
  // carries the scope name. Without the feeds screen the scope name stays.
  const itemsTitle = feed ? feedTitle(feed) : view.section === "search" ? `“${view.search}”` : settings.showFeeds ? "All items" : scopeName;
  const itemsBack = settings.showFeeds ? scopeName : "Fever";
  const refreshing = store.refreshJob && (store.refreshJob.status === "queued" || store.refreshJob.status === "running")
    ? `Refreshing ${store.refreshJob.completedFeeds} of ${store.refreshJob.totalFeeds} feeds…` : null;

  const emptyItems = (
    <>
      <p>
        {view.section === "search" ? `No items matched your search for “${view.search}”.`
          : view.section === "saved" ? "There are no saved items."
            : feed?.requiresAuth ? "This feed requires authentication."
              : !view.showRead ? `There are no unread items in this ${view.feedId ? "feed" : "group"}.`
                : `There are no items in this ${view.feedId ? "feed" : "group"}.`}
      </p>
      {feed?.requiresAuth ? <TextButton onClick={() => openManagement("auth-feed", { feed })}>Authenticate feed…</TextButton> : null}
      {data.feeds.length === 0 ? <TextButton onClick={() => openManagement("add-feed")}>New feed…</TextButton> : null}
    </>
  );
  const emptyHot = (
    <>
      <p>{data.feeds.length === 0 ? "Subscribe to feeds to see what is hot." : "Nothing to report for this time period."}</p>
      {data.feeds.length === 0
        ? <TextButton onClick={() => openManagement("add-feed")}>New feed…</TextButton>
        : view.hotRange < 31 ? <TextButton onClick={() => ctl.setHotWindow(0, view.hotRange < 7 ? 7 : 31)}>Try the past {view.hotRange < 7 ? "week" : "month"}</TextButton> : null}
    </>
  );

  const notice = store.notice ? (
    <div className={`mobile-notice${store.notice.kind === "error" ? " error" : ""}`} role={store.notice.kind === "error" ? "alert" : "status"}>
      {store.notice.text}
      {store.notice.action ? <button type="button" className="link-button" onClick={() => { store.setNotice(null); store.notice?.action?.(); }}>{store.notice.actionLabel ?? "Retry"}</button> : null}
      <button type="button" className="close" aria-label="Dismiss" onClick={() => store.setNotice(null)}>Dismiss</button>
    </div>
  ) : null;

  let screen: React.ReactNode;
  switch (route.screen) {
    case "feeds":
      screen = <FeedsScreen data={data} view={view} title={view.section === "search" ? `“${view.search}”` : scopeName} titleClass={scopeClass} onBack={goBack} onFeed={loadFeed} />;
      break;
    case "items":
      screen = (
        <ItemsScreen data={data} view={view} items={list.items} back={itemsBack} title={itemsTitle} onBack={goBack} onItem={(item) => openItem(item.id)}
          loading={store.loading} pageLoading={store.pageLoading} hasMore={list.hasMore} error={store.viewError} pageError={store.pageError}
          onRetry={() => void store.reload()} onMore={() => void store.loadNextPage()} empty={emptyItems} />
      );
      break;
    case "hot":
      screen = (
        <HotScreen data={data} view={view} links={list.links} onBack={goBack}
          onWindow={(start, range) => store.navigate({ hotStart: start, hotRange: range }, { history: "none" })}
          onItem={openItem} onExternal={(url, itemId) => openUrl(url, itemId)}
          loading={store.loading} pageLoading={store.pageLoading} hasMore={list.hasMore} error={store.viewError} pageError={store.pageError}
          onRetry={() => void store.reload()} onMore={() => void store.loadNextPage()} empty={emptyHot} />
      );
      break;
    case "article":
      if (!articleItem) {
        screen = (
          <div id="item">
            <header className="header"><div className="left"><button type="button" className="btn back" onClick={goBack}>Back</button></div><h1 className="title">Article</h1><div className="right" /></header>
            <div className="box message" role={routeStandalone?.error ? "alert" : "status"}>
              <p>{routeStandalone?.error ?? "Loading…"}</p>
              {routeStandalone?.error ? (
                <button type="button" className="btn" onClick={() => { void store.loadArticle(route.itemId, true); }}>Try again</button>
              ) : null}
            </div>
          </div>
        );
      } else {
        const articleFeed = data.feeds.find((row) => row.id === articleItem.feedId);
        const back = view.section === "hot" ? "Hot" : feed ? feedTitle(feed) : scopeName;
        screen = (
          <ArticleScreen
            item={articleItem} feed={articleFeed} back={back} onBack={goBack}
            preferences={data.preferences} highlight={view.section === "search" ? view.search : undefined}
            onToggleSave={() => store.toggleSave(articleItem.id)}
            onPrevious={() => void stepArticle(-1)} onNext={() => void stepArticle(1)}
            hasPrevious={index > 0} hasNext={index >= 0 && (index < siblings.length - 1 || (list.hasMore && view.section !== "hot"))}
            nextLoading={nextPending}
            onOpenExternal={(url) => openUrl(url)}
            onContentLink={(url) => openUrl(url)}
          />
        );
      }
      break;
    case "webview":
      screen = <WebviewScreen url={route.url} anonymize={data.preferences.anonymize} onBack={goBack} onOpenExternal={() => openExternal(route.url, data.preferences)} />;
      break;
    default:
      screen = (
        <GroupsScreen data={data} view={{ ...view, showRead: settings.showRead }} now={now} refreshing={refreshing}
          onSection={loadSection} onGroup={loadGroup} onSearch={loadSearch} onPreferences={() => setPrefsOpen(true)}
          onRefresh={() => void store.startRefresh({ scope: "all" })} onCancelRefresh={() => void store.cancelRefresh()} onLogout={onLogout} />
      );
  }

  return (
    <div className={`fever-mobile${prefsOpen ? " dialog" : ""}`}>
      <div id="screens-container">
        <div className={`screen screen-${route.screen}`} key={`${route.screen}-${route.itemId}`}>{screen}</div>
      </div>
      {store.refreshError ? <div className="mobile-notice error" role="alert">{store.refreshError}</div> : null}
      {notice}
      {prefsOpen ? (
        <MobilePreferences
          settings={settings}
          preferences={data.preferences}
          onChangeSettings={onSettings}
          onSavePreferences={async (patch) => {
            await store.run("preferences.save", patch);
            await store.softReload(false);
          }}
          onUndo={() => { setPrefsOpen(false); void store.undoRecentlyRead(); }}
          onAllPreferences={() => { setPrefsOpen(false); openManagement("preferences"); }}
          onDesktop={() => { setPrefsOpen(false); onDesktop(); }}
          onLogout={onLogout}
          onClose={() => setPrefsOpen(false)}
        />
      ) : null}
    </div>
  );
}

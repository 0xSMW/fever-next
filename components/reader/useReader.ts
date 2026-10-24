"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandAction, HotLinkDTO, ItemDTO, ReaderView, RefreshJobDTO, Section, ViewState } from "@/lib/contracts";
import { SESSION_EXPIRED_EVENT, apiGet, command, errorMessage, isApiError } from "@/lib/client/api";
import { type HrefExtras, normalizeFocus, readerHref } from "@/lib/client/url-state";
import type { CommandPayload, CommandResult } from "@/lib/command-contract";
import { readerRequest, createReaderPersistenceLane, type ReaderLoadPurpose } from "@/lib/client/reader-requests";
import { readFeverHistory, writeFeverHistory, updateFeverHistory, type FeverHistoryState } from "@/lib/client/reader-history";
import { createItemMutationCoordinator, itemTransition, type ItemFlags } from "./item-mutations";
import { adjustFeedCounts, findItem, patchArticle, patchItemEverywhere } from "./model";

export interface Notice {
  id: number;
  kind: "info" | "error";
  text: string;
  actionLabel?: string;
  action?: () => void;
}

export interface ListState {
  items: ItemDTO[];
  links: HotLinkDTO[];
  page: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Server render time of the first page; the cutoff for scope.read. */
  renderedAt: number;
  /** Identity of the view these rows belong to. */
  key: string;
  /** Increments on every first-page load (navigation or reload). */
  loadId: number;
}

export type RefreshScope = { scope: "all" } | { scope: "group"; id: number } | { scope: "feed"; id: number };
export type ReadScope = { scope: "all" } | { scope: "sparks" } | { scope: "group"; id: number } | { scope: "feed"; id: number };

export type { FeverHistoryState } from "@/lib/client/reader-history";
interface ReaderSnapshot { key: string; generation: number; result: ReaderView; revision: number; }
interface ArticleState { itemId: number; item: ItemDTO | null; error: string | null; loading: boolean; }

export const EMPTY_LIST: ListState = { items: [], links: [], page: 0, hasMore: false, nextCursor: null, renderedAt: 0, key: "", loadId: 0 };
let loadCounter = 0;
const ACTIVE_JOB = new Set<RefreshJobDTO["status"]>(["queued", "running"]);

export function viewKey(view: ViewState): string {
  return [view.section, view.groupId, view.feedId, view.search, view.showRead, view.showFeeds, view.hotStart, view.hotRange].join("|");
}

/**
 * The list when its rows belong to the view; otherwise an empty list.
 * navigate() changes the view at once and keeps the old rows until the new
 * first page arrives, so rows, links, paging and siblings read through this.
 */
export function scopedList(list: ListState, view: ViewState): ListState {
  return list.key === viewKey(view) ? list : EMPTY_LIST;
}

function dedupe<T extends { id: number }>(rows: T[], existing: T[] = []): T[] {
  const seen = new Set(existing.map((row) => row.id));
  const result = [...existing];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    result.push(row);
  }
  return result;
}

export function normalizeView(next: ViewState): ViewState {
  const view = { ...next };
  if (view.section === "hot") view.feedId = 0;
  if (!["groups", "feeds", "items", "links", "article"].includes(view.hasFocus) && !/^(item|link)-\d+$/.test(view.hasFocus)) view.hasFocus = "groups";
  return view;
}

export interface UseReaderOptions {
  /** Persist navigation through view.save (desktop only; mobile keeps device settings). */
  persistView: boolean;
  /** Query overrides for device-local mobile settings. */
  overrides?: Partial<ViewState>;
}

export function useReader(initialView: ViewState, options: UseReaderOptions) {
  const [view, setViewState] = useState<ViewState>(initialView);
  const [data, setData] = useState<ReaderView | null>(null);
  const [list, setList] = useState<ListState>(EMPTY_LIST);
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [refreshJob, setRefreshJob] = useState<RefreshJobDTO | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [notice, setNoticeState] = useState<Notice | null>(null);
  const [pendingFresh, setPendingFresh] = useState<ReaderSnapshot | null>(null);
  const [article, setArticleState] = useState<ArticleState>({ itemId: 0, item: null, error: null, loading: false });

  const viewRef = useRef(view);
  const dataRef = useRef(data);
  const listRef = useRef(list);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pendingOps = useRef(0);
  const articleRef = useRef(article);
  const articleRequest = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const [persistence] = useState(createReaderPersistenceLane);
  const acknowledged = useRef<{ key: string; focus: string } | null>(null);
  const pageBusy = useRef<{ generation: number } | null>(null);
  const reloadSeq = useRef(0);
  const mounted = useRef(true);
  const [mutations] = useState(() => createItemMutationCoordinator({
    read: ids => command("items.read", { ids }),
    reconcile: async () => undefined,
    failed: () => undefined,
  }));
  const noticeId = useRef(0);
  const restoreScrollRef = useRef<number | null>(null);
  const extrasRef = useRef<HrefExtras>({});
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const overridesRef = useRef(options.overrides);
  const persistViewRef = useRef(options.persistView);
  // Callbacks read the committed values. Layout effects run after each commit,
  // before passive effects and event handlers; setView() also writes viewRef
  // at once, and markRead() patches listRef for lookups in the same tick.
  useLayoutEffect(() => {
    overridesRef.current = options.overrides;
    persistViewRef.current = options.persistView;
  }, [options.overrides, options.persistView]);
  useLayoutEffect(() => { viewRef.current = view; }, [view]);
  useLayoutEffect(() => { dataRef.current = data; }, [data]);
  useLayoutEffect(() => { listRef.current = list; }, [list]);

  const setNotice = useCallback((value: Omit<Notice, "id"> | null) => {
    setNoticeState(value ? { ...value, id: ++noticeId.current } : null);
  }, []);

  const setView = useCallback((next: ViewState) => {
    viewRef.current = next;
    setViewState(next);
  }, []);

  const queryFor = useCallback((target: ViewState, purpose: ReaderLoadPurpose, page = 1, cursor?: string | null) =>
    readerRequest({ ...target, ...(overridesRef.current ?? {}) }, purpose, persistViewRef.current, page, cursor), []);

  const setArticle = useCallback((next: ArticleState) => { articleRef.current = next; setArticleState(next); }, []);
  const updateList = useCallback((next: ListState) => { listRef.current = next; setList(next); }, []);
  const updateData = useCallback((next: ReaderView | null) => { dataRef.current = next; setData(next); }, []);

  const applyFirstPage = useCallback((result: ReaderView, requested: ViewState) => {
    const serverView: ViewState = { ...requested, ...result.view, hasFocus: requested.hasFocus };
    // Device-local overrides are not adopted from the server's stored view.
    if (overridesRef.current) Object.assign(serverView, overridesRef.current);
    const next = normalizeView(serverView);
    if (viewKey(next) !== viewKey(requested) && typeof window !== "undefined") {
      updateFeverHistory({ view: next }, readerHref(next, extrasRef.current));
    }
    setView(next);
    updateData(result);
    setPendingFresh(null);
    updateList({
      items: dedupe(result.items), links: dedupe(result.links),
      page: result.page || 1, hasMore: result.hasMore, nextCursor: result.nextCursor ?? null,
      renderedAt: result.renderedAt, key: viewKey(next), loadId: ++loadCounter,
    });
    if (result.refreshJob !== undefined) setRefreshJob(result.refreshJob ?? null);
  }, [setView, updateData, updateList]);

  /** Visits persist in order; read-only reloads can be superseded and aborted. */
  const loadView = useCallback(async (target: ViewState, restoreScroll: number | null = null, purpose: ReaderLoadPurpose = "reload") => {
    const generation = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    const capture = purpose === "visit" && persistViewRef.current;
    abortRef.current = capture ? null : controller;
    restoreScrollRef.current = restoreScroll;
    pageBusy.current = null;
    setPageLoading(false);
    setPendingFresh(null);
    setLoading(true);
    setViewError(null);
    setPageError(null);
    const fetchView = async () => {
      await flushRef.current();
      if (!mounted.current || generation !== seqRef.current) return;
      let revision = mutations.revision;
      let result = await apiGet<ReaderView>(queryFor(target, purpose), capture ? undefined : { signal: controller.signal });
      if (capture) acknowledged.current = { key: viewKey({ ...target, ...result.view }), focus: normalizeFocus(result.view.hasFocus) };
      if (!mounted.current || generation !== seqRef.current) return;
      while (revision !== mutations.revision) {
        await flushRef.current();
        if (!mounted.current || generation !== seqRef.current) return;
        revision = mutations.revision;
        result = await apiGet<ReaderView>(queryFor(target, "reload"), { signal: controller.signal });
        if (!mounted.current || generation !== seqRef.current) return;
      }
      applyFirstPage(result, target);
    };
    try {
      if (capture) await persistence.schedule("visit", fetchView);
      else await fetchView();
    } catch (error) {
      if (!mounted.current || generation !== seqRef.current || (isApiError(error) && (error.isAborted || error.isUnauthenticated))) return;
      setViewError(errorMessage(error, "The reader could not be loaded."));
    } finally {
      if (mounted.current && generation === seqRef.current) setLoading(false);
    }
  }, [applyFirstPage, mutations, persistence, queryFor]);

  /** Re-fetch page 1 without replacing the rows being read. */
  const softReload = useCallback(async (autoApply = false) => {
    const target = viewRef.current;
    const seq = seqRef.current;
    const reload = ++reloadSeq.current;
    try {
      await flushRef.current();
      if (seq !== seqRef.current || reload !== reloadSeq.current || !mounted.current) return;
      const revision = mutations.revision;
      const result = await apiGet<ReaderView>(queryFor(target, "reload"));
      if (!mounted.current || seq !== seqRef.current || reload !== reloadSeq.current || revision !== mutations.revision || viewKey(target) !== viewKey(viewRef.current)) return;
      const current = listRef.current;
      const known = new Set(target.section === "hot" ? current.links.map((l) => l.id) : current.items.map((i) => i.id));
      const fresh = (target.section === "hot" ? result.links : result.items).filter((row) => !known.has(row.id)).length;
      if (autoApply || (!current.items.length && !current.links.length)) {
        applyFirstPage(result, target);
        return;
      }
      if (pendingOps.current === 0) {
        setData((previous) => previous ? {
          ...previous, groups: result.groups, feeds: result.feeds, preferences: result.preferences,
          visibleFeedIds: result.visibleFeedIds, searchCounts: result.searchCounts,
          unreadCount: result.unreadCount, savedCount: result.savedCount, lastRefreshedAt: result.lastRefreshedAt,
          lastSessionAt: result.lastSessionAt, refreshJob: result.refreshJob,
        } : result);
      } else {
        setData((previous) => previous ? { ...previous, lastRefreshedAt: result.lastRefreshedAt } : result);
      }
      setPendingFresh(fresh > 0 ? { key: viewKey(target), generation: seq, result, revision } : null);
    } catch (error) {
      if (!mounted.current || seq !== seqRef.current || reload !== reloadSeq.current || (isApiError(error) && error.isUnauthenticated)) return;
      setNotice({ kind: "error", text: `Counts could not be updated: ${errorMessage(error)}` });
    }
  }, [applyFirstPage, mutations, queryFor, setNotice]);

  const showFresh = useCallback(() => {
    const fresh = pendingFresh;
    if (fresh && fresh.key === viewKey(viewRef.current) && fresh.generation === seqRef.current && fresh.revision === mutations.revision) {
      void flushRef.current().then(() => {
        if (fresh.key === viewKey(viewRef.current) && fresh.generation === seqRef.current && fresh.revision === mutations.revision) applyFirstPage(fresh.result, viewRef.current);
      }).catch(() => undefined);
    }
  }, [applyFirstPage, mutations, pendingFresh]);

  const loadNextPage = useCallback(async () => {
    const current = listRef.current;
    // Rows of a previous view: its cursor does not describe the current query.
    if (!current.hasMore || pageBusy.current || loading || current.key !== viewKey(viewRef.current)) return false;
    const seq = seqRef.current;
    const token = { generation: seq };
    pageBusy.current = token;
    const target = viewRef.current;
    setPageLoading(true);
    setPageError(null);
    try {
      await flushRef.current();
      if (seq !== seqRef.current || !mounted.current) return false;
      const revision = mutations.revision;
      const result = await apiGet<ReaderView>(queryFor(target, "page", current.page + 1, current.nextCursor));
      if (!mounted.current || seq !== seqRef.current || revision !== mutations.revision) return false;
      setList((previous) => {
        if (previous.key !== current.key) return previous;
        const items = dedupe(result.items, previous.items);
        const links = dedupe(result.links, previous.links);
        const added = items.length - previous.items.length + links.length - previous.links.length;
        const advanced = (result.nextCursor ?? null) !== previous.nextCursor || (result.page || previous.page + 1) > previous.page;
        return {
          ...previous, items, links,
          page: result.page || previous.page + 1,
          // Guard against a server returning only duplicates without advancing.
          hasMore: result.hasMore && (added > 0 || advanced),
          nextCursor: result.nextCursor ?? null,
        };
      });
      setData((previous) => previous ? { ...previous, lastRefreshedAt: result.lastRefreshedAt } : previous);
      return true;
    } catch (error) {
      if (seq !== seqRef.current) return false;
      if (!(isApiError(error) && error.isUnauthenticated)) setPageError(errorMessage(error, "More items could not be loaded."));
      return false;
    } finally {
      if (pageBusy.current === token) { pageBusy.current = null; if (mounted.current) setPageLoading(false); }
    }
  }, [loading, mutations, queryFor]);

  const setExtras = useCallback((extras: HrefExtras) => { extrasRef.current = extras; }, []);

  /**
   * Change the view. history: push adds an entry, replace rewrites the
   * current one, none leaves the URL alone (popstate restores).
   */
  const navigate = useCallback((patch: Partial<ViewState>, opts: { history?: "push" | "replace" | "none"; extras?: HrefExtras; restoreScroll?: number | null; panes?: Record<string, number> } = {}) => {
    const current = viewRef.current;
    let next = normalizeView({ ...current, ...patch });
    if (next.section === "search" && current.section !== "search" && patch.previous === undefined) next = { ...next, previous: current.section };
    if (next.section !== "search" && patch.section && patch.section !== current.section) next = { ...next, previous: next.section };
    const mode = opts.history ?? "push";
    if (opts.extras) extrasRef.current = opts.extras;
    if (mode !== "none" && typeof window !== "undefined") {
      const state = readFeverHistory();
      const depth = state?.depth ?? 0;
      writeFeverHistory("replace", { ...(state ?? { view: current }), view: current, scrollY: window.scrollY, panes: opts.panes ?? state?.panes }, window.location.href);
      const entry: FeverHistoryState = { view: next, extras: extrasRef.current, depth: mode === "push" ? depth + 1 : depth };
      writeFeverHistory(mode, entry, readerHref(next, extrasRef.current));
    }
    setView(next);
    // Send queued reads first so the next view's counts include them.
    void loadView(next, opts.restoreScroll ?? null, "visit");
  }, [loadView, setView]);

  const reload = useCallback(() => loadView(viewRef.current), [loadView]);

  /**
   * First load without a deep link: ask for the server-stored view (no view
   * parameters), adopt it, and write it to the address bar.
   */
  const bootstrap = useCallback(async (extras: HrefExtras) => {
    extrasRef.current = extras;
    const seq = ++seqRef.current;
    setLoading(true);
    setViewError(null);
    try {
      const overrides = overridesRef.current;
      const query = new URLSearchParams();
      if (overrides?.showRead !== undefined) query.set("showRead", overrides.showRead ? "1" : "0");
      if (overrides?.showFeeds !== undefined) query.set("showFeeds", overrides.showFeeds ? "1" : "0");
      if (!persistViewRef.current) query.set("capture", "false");
      const suffix = query.toString();
      let result: ReaderView | undefined;
      const fetchInitial = async () => {
        if (seq !== seqRef.current || !mounted.current) return;
        await flushRef.current();
        result = await apiGet<ReaderView>(`/api/reader${suffix ? `?${suffix}` : ""}`);
        if (persistViewRef.current) acknowledged.current = { key: viewKey(result.view), focus: normalizeFocus(result.view.hasFocus) };
      };
      if (persistViewRef.current) await persistence.schedule("visit", fetchInitial);
      else await fetchInitial();
      if (!result || !mounted.current || seq !== seqRef.current) return;
      const adopted = normalizeView({ ...result.view, ...(overrides ?? {}) });
      writeFeverHistory("replace", { view: adopted, extras, depth: 0 }, readerHref(adopted, extras));
      applyFirstPage(result, adopted);
    } catch (error) {
      if (seq !== seqRef.current || (isApiError(error) && error.isUnauthenticated)) return;
      setViewError(errorMessage(error, "The reader could not be loaded."));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [applyFirstPage, persistence]);

  /** Consume the scroll position requested by the latest navigation. */
  const takeRestoreScroll = useCallback(() => {
    const value = restoreScrollRef.current;
    restoreScrollRef.current = null;
    return value;
  }, []);

  /* ---------------- item state mutations ---------------- */

  const run = useCallback(async <A extends CommandAction>(action: A, payload: CommandPayload<A>): Promise<CommandResult<A>> => {
    pendingOps.current += 1;
    try { return await command(action, payload); }
    finally { pendingOps.current -= 1; }
  }, []);

  const getItem = useCallback((id: number) => findItem(listRef.current.items, listRef.current.links, id, articleRef.current.item), []);
  const applyFlags = useCallback((id: number, flags: ItemFlags) => {
    const current = getItem(id);
    if (!current) return;
    setPendingFresh(null);
    const transition = itemTransition(current, flags);
    updateList(patchItemEverywhere(listRef.current, id, transition.after));
    setArticle({ ...articleRef.current, item: patchArticle(articleRef.current.item, id, transition.after) });
    updateData(dataRef.current ? adjustFeedCounts(dataRef.current, current.feedId, transition.unreadDelta, transition.savedDelta) : null);
  }, [getItem, setArticle, updateData, updateList]);

  const loadArticle = useCallback(async (itemId: number, force = false) => {
    const found = getItem(itemId);
    if (found && !force) return found;
    articleRequest.current.controller?.abort();
    const controller = new AbortController();
    const generation = ++articleRequest.current.generation;
    articleRequest.current.controller = controller;
    setArticle({ itemId, item: null, error: null, loading: true });
    try {
      await mutations.whenSettled();
      const item = await apiGet<ItemDTO>(`/api/items/${itemId}`, { signal: controller.signal });
      if (mounted.current && generation === articleRequest.current.generation) setArticle({ itemId, item, error: null, loading: false });
      return item;
    } catch (error) {
      if (mounted.current && generation === articleRequest.current.generation && !controller.signal.aborted) {
        setArticle({ itemId, item: null, error: errorMessage(error, "This item could not be loaded."), loading: false });
      }
      return null;
    }
  }, [getItem, mutations, setArticle]);
  const cancelArticle = useCallback(() => {
    articleRequest.current.generation++;
    articleRequest.current.controller?.abort();
  }, []);

  const flushReads = useCallback(() => mutations.flushReads(), [mutations]);
  useLayoutEffect(() => {
    flushRef.current = flushReads;
    mutations.configure({
      read: ids => command("items.read", { ids }),
      failed: error => {
        if (mounted.current && !(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: `Reading changes could not be confirmed: ${errorMessage(error)}` });
      },
      reconcile: async revision => {
        const target = viewRef.current;
        const generation = seqRef.current;
        const result = await apiGet<ReaderView>(queryFor(target, "reload"));
        const slot = articleRef.current;
        const item = slot.item ? await apiGet<ItemDTO>(`/api/items/${slot.itemId}`) : null;
        if (!mounted.current || revision !== mutations.revision) return;
        if (generation === seqRef.current && viewKey(target) === viewKey(viewRef.current)) applyFirstPage(result, target);
        if (item && articleRef.current.itemId === slot.itemId) setArticle({ ...slot, item, error: null, loading: false });
      },
    });
  }, [applyFirstPage, flushReads, mutations, queryFor, setArticle, setNotice]);

  const markRead = useCallback((ids: number[], immediate = false) => {
    const now = Math.floor(Date.now() / 1000);
    for (const id of ids) {
      const item = getItem(id);
      if (!item || item.readAt || item.isSaved) continue;
      const transition = itemTransition(item, { readAt: now });
      applyFlags(id, transition.after);
      mutations.queueRead(id, () => applyFlags(id, transition.before));
    }
    if (immediate) void flushReads().catch(() => undefined);
  }, [applyFlags, flushReads, getItem, mutations]);

  const markUnread = useCallback((id: number) => {
    const item = getItem(id);
    if (!item || !item.readAt || item.isSaved) return;
    const transition = itemTransition(item, { readAt: 0, isNew: false });
    applyFlags(id, transition.after);
    void mutations.submit(id, () => run("items.unread", { ids: [id] }), () => applyFlags(id, transition.before)).catch(() => undefined);
  }, [applyFlags, getItem, mutations, run]);

  /** UI-origin saves atomically mark an unread item read on the server. */
  const toggleSave = useCallback((id: number) => {
    const before = getItem(id);
    if (!before) return;
    const saving = !before.isSaved;
    const transition = itemTransition(before, { isSaved: saving, ...(saving && !before.readAt ? { readAt: Math.floor(Date.now() / 1000) } : {}) });
    applyFlags(id, transition.after);
    void mutations.submit(id, () => run(saving ? "items.save" : "items.unsave", { ids: [id] }), () => applyFlags(id, transition.before)).catch(() => undefined);
  }, [applyFlags, getItem, mutations, run]);

  /** Mark a whole scope read at the first page's render-time cutoff. */
  const markScopeRead = useCallback(async (scope: ReadScope) => {
    const before = listRef.current.renderedAt || dataRef.current?.renderedAt || Math.floor(Date.now() / 1000);
    try {
      await flushReads();
      await mutations.enqueue(() => run("scope.read", { ...scope, before }));
      await loadView(viewRef.current);
    } catch (error) {
      await flushReads().catch(() => undefined);
      if (!(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: `Could not mark as read: ${errorMessage(error)}` });
    }
  }, [flushReads, loadView, mutations, run, setNotice]);

  const undoRecentlyRead = useCallback(async () => {
    try {
      await flushReads();
      await mutations.enqueue(() => run("items.undo", { section: viewRef.current.section }));
      await loadView(viewRef.current);
      setNotice({ kind: "info", text: "Most recently read items are unread again." });
    } catch (error) {
      await flushReads().catch(() => undefined);
      if (!(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: `Undo failed: ${errorMessage(error)}` });
    }
  }, [flushReads, loadView, mutations, run, setNotice]);

  /** Generic command followed by a reload (membership, Sparks, preferences). */
  const commandThenReload = useCallback(async <A extends CommandAction>(action: A, payload: CommandPayload<A>, success?: string) => {
    try {
      await flushReads();
      const result = await run(action, payload);
      await loadView(viewRef.current);
      if (success) setNotice({ kind: "info", text: success });
      return result;
    } catch (error) {
      if (!(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: errorMessage(error) });
      return null;
    }
  }, [flushReads, loadView, run, setNotice]);

  /* ---------------- refresh jobs ---------------- */

  const startRefresh = useCallback(async (target: RefreshScope, force = true) => {
    setRefreshError(null);
    try {
      const result = await run("refresh.start", { ...target, force });
      setRefreshJob(result.job);
    } catch (error) {
      if (!(isApiError(error) && error.isUnauthenticated)) setRefreshError(errorMessage(error, "The refresh could not be started."));
    }
  }, [run]);

  const cancelRefresh = useCallback(async () => {
    const job = refreshJob;
    if (!job) return;
    try {
      const result = await run("refresh.cancel", { id: job.id });
      setRefreshJob(result.job);
    } catch (error) {
      if (!(isApiError(error) && error.isUnauthenticated)) setRefreshError(`The refresh could not be cancelled: ${errorMessage(error)}`);
    }
  }, [refreshJob, run]);

  // Poll persisted job progress while a job is queued or running.
  const jobId = refreshJob?.id ?? 0;
  const jobActive = refreshJob ? ACTIVE_JOB.has(refreshJob.status) : false;
  useEffect(() => {
    if (!jobId || !jobActive) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const job = await apiGet<RefreshJobDTO | null>(`/api/refresh?id=${jobId}`);
        if (stopped) return;
        failures = 0;
        setRefreshError(null);
        if (!job) { setRefreshJob(null); return; }
        setRefreshJob(job);
        if (ACTIVE_JOB.has(job.status)) timer = setTimeout(poll, 1500);
        else if (job.status === "completed") void softReload(Boolean(dataRef.current?.preferences.autoReload) && window.scrollY < 8);
        else void softReload(false);
      } catch (error) {
        if (stopped || (isApiError(error) && error.isUnauthenticated)) return;
        failures += 1;
        setRefreshError(`Lost contact with the refresh (${errorMessage(error)}). Retrying…`);
        timer = setTimeout(poll, Math.min(30_000, 1500 * 2 ** failures));
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [jobActive, jobId, softReload]);

  // Browser auto-refresh: enqueue a normal refresh when the interval passes.
  const lastAutoAttempt = useRef(0);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = dataRef.current;
      if (!current || !current.preferences.autoRefresh || expired) return;
      if (refreshJob && ACTIVE_JOB.has(refreshJob.status)) return;
      const interval = Math.max(1, current.preferences.refreshInterval) * 60;
      const now = Date.now() / 1000;
      if (now - Math.max(current.lastRefreshedAt, lastAutoAttempt.current) < interval) return;
      lastAutoAttempt.current = now;
      void startRefresh({ scope: "all" }, false);
    }, 60_000);
    return () => clearInterval(timer);
  }, [expired, refreshJob, startRefresh]);

  /* ---------------- session expiry ---------------- */

  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  /* ---------------- view persistence ---------------- */

  const persistKey = `${viewKey(view)}|${normalizeFocus(view.hasFocus)}`;
  const hasData = Boolean(data);
  useEffect(() => {
    if (!options.persistView || !hasData || loading) return;
    const target = viewRef.current;
    const focus = normalizeFocus(target.hasFocus);
    if (acknowledged.current?.key !== viewKey(target) || acknowledged.current.focus === focus) return;
    const timer = setTimeout(() => {
      void persistence.schedule("focus", async () => {
        if (!mounted.current || !persistViewRef.current || viewKey(viewRef.current) !== viewKey(target)) return;
        if (acknowledged.current?.key !== viewKey(target) || acknowledged.current.focus === focus) return;
        const result = await command("view.save", { hasFocus: focus });
        acknowledged.current = { key: viewKey(result.view), focus: normalizeFocus(result.view.hasFocus) };
      }).catch(error => {
        if (mounted.current && !(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: `Your reading position could not be saved: ${errorMessage(error)}` });
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [persistKey, options.persistView, hasData, loading, persistence, setNotice]);

  useEffect(() => {
    mounted.current = true;
    const flush = () => { void flushReads().catch(() => undefined); };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      mounted.current = false;
      // These refs track request generations rather than DOM nodes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++seqRef.current;
      abortRef.current?.abort();
      // eslint-disable-next-line react-hooks/exhaustive-deps
      articleRequest.current.controller?.abort();
      mutations.dispose();
      flush();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, [flushReads, mutations]);

  const setFocus = useCallback((focus: string) => {
    if (viewRef.current.hasFocus === focus) return;
    setView({ ...viewRef.current, hasFocus: focus });
  }, [setView]);

  const sectionChange = useCallback((section: Section) => navigate({ section, feedId: 0, hasFocus: "groups" }), [navigate]);

  return useMemo(() => ({
    view, data, list, loading, pageLoading, viewError, pageError, expired, refreshJob, refreshError,
    notice, pendingFresh: pendingFresh?.result ?? null, article, getItem, loadArticle, cancelArticle,
    setNotice, navigate, reload, bootstrap, loadView, softReload, showFresh, loadNextPage, takeRestoreScroll, setExtras,
    markRead, markUnread, toggleSave, markScopeRead, undoRecentlyRead, commandThenReload, flushReads,
    startRefresh, cancelRefresh, setFocus, sectionChange, setView, run,
  }), [view, data, list, loading, pageLoading, viewError, pageError, expired, refreshJob, refreshError, notice, pendingFresh, article, getItem, loadArticle, cancelArticle,
    setNotice, navigate, reload, bootstrap, loadView, softReload, showFresh, loadNextPage, takeRestoreScroll, setExtras, markRead, markUnread,
    toggleSave, markScopeRead, undoRecentlyRead, commandThenReload, flushReads, startRefresh, cancelRefresh, setFocus,
    sectionChange, setView, run]);
}

export type ReaderStore = ReturnType<typeof useReader>;

"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandAction, HotLinkDTO, ItemDTO, ReaderView, RefreshJobDTO, Section, ViewState } from "@/lib/contracts";
import { SESSION_EXPIRED_EVENT, apiGet, command, errorMessage, isApiError } from "@/lib/client/api";
import { type HrefExtras, normalizeFocus, readerHref, readerQueryString } from "@/lib/client/url-state";
import { adjustFeedCounts, findItem, patchItemEverywhere } from "./model";

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

export interface FeverHistoryState { view: ViewState; extras?: HrefExtras; scrollY?: number; panes?: Record<string, number>; depth?: number; }

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

function jobFromResult(result: Record<string, unknown>): RefreshJobDTO | null {
  const candidates = [result.job, result.refreshJob, result];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const job = candidate as Partial<RefreshJobDTO>;
      if (typeof job.id === "number" && typeof job.status === "string") return job as RefreshJobDTO;
    }
  }
  const id = typeof result.id === "number" ? result.id : typeof result.jobId === "number" ? result.jobId : null;
  if (id === null) return null;
  return { id, status: "queued", totalFeeds: 0, completedFeeds: 0, createdAt: Math.floor(Date.now() / 1000) };
}

export function normalizeView(next: ViewState): ViewState {
  const view = { ...next };
  if (view.section === "hot") view.feedId = 0;
  if (!["groups", "feeds"].includes(view.hasFocus) && !/^(item|link)-\d+$/.test(view.hasFocus)) view.hasFocus = "groups";
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
  const [pendingFresh, setPendingFresh] = useState<ReaderView | null>(null);

  const viewRef = useRef(view);
  const dataRef = useRef(data);
  const listRef = useRef(list);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pendingOps = useRef(0);
  const readQueue = useRef(new Set<number>());
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeId = useRef(0);
  const restoreScrollRef = useRef<number | null>(null);
  const extrasRef = useRef<HrefExtras>({});
  const flushRef = useRef<() => void>(() => undefined);
  const markReadRef = useRef<(ids: number[]) => void>(() => undefined);
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

  const queryFor = useCallback((target: ViewState, page = 1, cursor?: string | null) => {
    const merged = { ...target, ...(overridesRef.current ?? {}) };
    // GET /api/reader stores the requested view unless capture=false; mobile keeps it device-local.
    const capture = persistViewRef.current ? "" : "&capture=false";
    return `/api/reader?${readerQueryString(merged, page, cursor)}${capture}`;
  }, []);

  const applyFirstPage = useCallback((result: ReaderView, requested: ViewState) => {
    const serverView: ViewState = { ...requested, ...result.view, hasFocus: requested.hasFocus };
    // Device-local overrides are not adopted from the server's stored view.
    if (overridesRef.current) Object.assign(serverView, overridesRef.current);
    const next = normalizeView(serverView);
    if (viewKey(next) !== viewKey(requested) && typeof window !== "undefined") {
      const state = (window.history.state ?? {}) as { fever?: FeverHistoryState };
      window.history.replaceState({ ...state, fever: { ...(state.fever ?? {}), view: next } }, "", readerHref(next, extrasRef.current));
    }
    setView(next);
    setData(result);
    setPendingFresh(null);
    setList({
      items: dedupe(result.items), links: dedupe(result.links),
      page: result.page || 1, hasMore: result.hasMore, nextCursor: result.nextCursor ?? null,
      renderedAt: result.renderedAt, key: viewKey(next), loadId: ++loadCounter,
    });
    if (result.refreshJob !== undefined) setRefreshJob(result.refreshJob ?? null);
  }, [setView]);

  /** Load page 1 for a view. Stale responses (older seq) are discarded. */
  const loadView = useCallback(async (target: ViewState, restoreScroll: number | null = null) => {
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    restoreScrollRef.current = restoreScroll;
    setLoading(true);
    setViewError(null);
    setPageError(null);
    try {
      const result = await apiGet<ReaderView>(queryFor(target), { signal: controller.signal });
      if (seq !== seqRef.current) return;
      applyFirstPage(result, target);
    } catch (error) {
      if (seq !== seqRef.current || (isApiError(error) && error.isAborted)) return;
      if (isApiError(error) && error.isUnauthenticated) return;
      setViewError(errorMessage(error, "The reader could not be loaded."));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [applyFirstPage, queryFor]);

  /** Re-fetch page 1 without replacing the rows being read. */
  const softReload = useCallback(async (autoApply = false) => {
    const target = viewRef.current;
    const seq = seqRef.current;
    try {
      const result = await apiGet<ReaderView>(queryFor(target));
      if (seq !== seqRef.current || viewKey(target) !== viewKey(viewRef.current)) return;
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
      setPendingFresh(fresh > 0 ? result : null);
    } catch (error) {
      if (isApiError(error) && error.isUnauthenticated) return;
      setNotice({ kind: "error", text: `Counts could not be updated: ${errorMessage(error)}` });
    }
  }, [applyFirstPage, queryFor, setNotice]);

  const showFresh = useCallback(() => {
    const fresh = pendingFresh;
    if (fresh) applyFirstPage(fresh, viewRef.current);
  }, [applyFirstPage, pendingFresh]);

  const pageBusy = useRef(false);
  const loadNextPage = useCallback(async () => {
    const current = listRef.current;
    // Rows of a previous view: its cursor does not describe the current query.
    if (!current.hasMore || pageBusy.current || loading || current.key !== viewKey(viewRef.current)) return false;
    pageBusy.current = true;
    const seq = seqRef.current;
    const target = viewRef.current;
    setPageLoading(true);
    setPageError(null);
    try {
      const result = await apiGet<ReaderView>(queryFor(target, current.page + 1, current.nextCursor));
      if (seq !== seqRef.current) return false;
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
      pageBusy.current = false;
      if (seq === seqRef.current) setPageLoading(false);
    }
  }, [loading, queryFor]);

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
      const state = (window.history.state ?? {}) as { fever?: FeverHistoryState };
      const depth = state.fever?.depth ?? 0;
      window.history.replaceState({ ...state, fever: { ...(state.fever ?? { view: current }), view: current, scrollY: window.scrollY, panes: opts.panes ?? state.fever?.panes } }, "", window.location.href);
      const entry: FeverHistoryState = { view: next, extras: extrasRef.current, depth: mode === "push" ? depth + 1 : depth };
      if (mode === "push") window.history.pushState({ fever: entry }, "", readerHref(next, extrasRef.current));
      else window.history.replaceState({ fever: entry }, "", readerHref(next, extrasRef.current));
    }
    setView(next);
    // Send queued reads first so the next view's counts include them.
    flushRef.current();
    void loadView(next, opts.restoreScroll ?? null);
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
      const result = await apiGet<ReaderView>(`/api/reader${suffix ? `?${suffix}` : ""}`);
      if (seq !== seqRef.current) return;
      const adopted = normalizeView({ ...result.view, ...(overrides ?? {}) });
      window.history.replaceState({ fever: { view: adopted, extras, depth: 0 } }, "", readerHref(adopted, extras));
      applyFirstPage(result, adopted);
    } catch (error) {
      if (seq !== seqRef.current || (isApiError(error) && error.isUnauthenticated)) return;
      setViewError(errorMessage(error, "The reader could not be loaded."));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [applyFirstPage]);

  /** Consume the scroll position requested by the latest navigation. */
  const takeRestoreScroll = useCallback(() => {
    const value = restoreScrollRef.current;
    restoreScrollRef.current = null;
    return value;
  }, []);

  /* ---------------- item state mutations ---------------- */

  const run = useCallback(async (action: CommandAction, payload: Record<string, unknown>) => {
    pendingOps.current += 1;
    try { return await command(action, payload); }
    finally { pendingOps.current -= 1; }
  }, []);

  const applyItemChange = useCallback((itemId: number, patch: Partial<ItemDTO>, unreadDelta: number, savedDelta: number, feedId: number) => {
    setList((previous) => patchItemEverywhere(previous, itemId, patch));
    setData((previous) => previous ? adjustFeedCounts(previous, feedId, unreadDelta, savedDelta) : previous);
  }, []);

  const flushReads = useCallback(() => {
    if (readTimer.current) { clearTimeout(readTimer.current); readTimer.current = null; }
    const ids = [...readQueue.current];
    readQueue.current.clear();
    if (!ids.length) return;
    run("items.read", { ids }).catch((error) => {
      // Restore every optimistic change that the server rejected.
      for (const id of ids) {
        const item = findItem(listRef.current.items, listRef.current.links, id);
        if (item && item.readAt && !item.isSaved) applyItemChange(id, { readAt: 0 }, 1, 0, item.feedId);
      }
      if (!(isApiError(error) && error.isUnauthenticated)) {
        setNotice({ kind: "error", text: `Items could not be marked as read: ${errorMessage(error)}`, actionLabel: "Retry", action: () => markReadRef.current(ids) });
      }
    });
  }, [applyItemChange, run, setNotice]);

  const markRead = useCallback((ids: number[], immediate = false) => {
    const now = Math.floor(Date.now() / 1000);
    let queued = false;
    for (const id of ids) {
      const item = findItem(listRef.current.items, listRef.current.links, id);
      if (!item || item.readAt || item.isSaved || readQueue.current.has(id)) continue;
      applyItemChange(id, { readAt: now }, -1, 0, item.feedId);
      // Keep the ref current for subsequent lookups in this tick.
      listRef.current = patchItemEverywhere(listRef.current, id, { readAt: now });
      readQueue.current.add(id);
      queued = true;
    }
    if (!queued) return;
    if (immediate) flushReads();
    else if (!readTimer.current) readTimer.current = setTimeout(flushReads, 250);
  }, [applyItemChange, flushReads]);
  // navigate() is declared above flushReads, and flushReads' Retry action calls markRead.
  useLayoutEffect(() => {
    flushRef.current = flushReads;
    markReadRef.current = markRead;
  }, [flushReads, markRead]);

  const markUnread = useCallback((id: number) => {
    const item = findItem(listRef.current.items, listRef.current.links, id);
    if (!item || !item.readAt || item.isSaved) return;
    readQueue.current.delete(id);
    applyItemChange(id, { readAt: 0, isNew: false }, 1, 0, item.feedId);
    listRef.current = patchItemEverywhere(listRef.current, id, { readAt: 0, isNew: false });
    run("items.unread", { ids: [id] }).catch((error) => {
      applyItemChange(id, { readAt: item.readAt }, -1, 0, item.feedId);
      if (!(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: `The item could not be marked as unread: ${errorMessage(error)}` });
    });
  }, [applyItemChange, run, setNotice]);

  /** UI save marks the backing item read first, as reader.js does. */
  const toggleSave = useCallback((id: number) => {
    const before = findItem(listRef.current.items, listRef.current.links, id);
    if (!before) return;
    if (!before.isSaved) markRead([id], true);
    const saving = !before.isSaved;
    applyItemChange(id, { isSaved: saving }, 0, saving ? 1 : -1, before.feedId);
    listRef.current = patchItemEverywhere(listRef.current, id, { isSaved: saving });
    run(saving ? "items.save" : "items.unsave", { ids: [id] }).catch((error) => {
      applyItemChange(id, { isSaved: !saving }, 0, saving ? -1 : 1, before.feedId);
      if (!(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: `The item could not be ${saving ? "saved" : "unsaved"}: ${errorMessage(error)}` });
    });
  }, [applyItemChange, markRead, run, setNotice]);

  /** Mark a whole scope read at the first page's render-time cutoff. */
  const markScopeRead = useCallback(async (scope: ReadScope) => {
    flushReads();
    const before = listRef.current.renderedAt || dataRef.current?.renderedAt || Math.floor(Date.now() / 1000);
    try {
      await run("scope.read", { ...scope, before });
      await loadView(viewRef.current);
    } catch (error) {
      if (!(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: `Could not mark as read: ${errorMessage(error)}` });
    }
  }, [flushReads, loadView, run, setNotice]);

  const undoRecentlyRead = useCallback(async () => {
    flushReads();
    try {
      await run("items.undo", { section: viewRef.current.section });
      await loadView(viewRef.current);
      setNotice({ kind: "info", text: "Most recently read items are unread again." });
    } catch (error) {
      if (!(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: `Undo failed: ${errorMessage(error)}` });
    }
  }, [flushReads, loadView, run, setNotice]);

  /** Generic command followed by a reload (membership, Sparks, preferences). */
  const commandThenReload = useCallback(async (action: CommandAction, payload: Record<string, unknown>, success?: string) => {
    try {
      const result = await run(action, payload);
      await loadView(viewRef.current);
      if (success) setNotice({ kind: "info", text: success });
      return result;
    } catch (error) {
      if (!(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: errorMessage(error) });
      return null;
    }
  }, [loadView, run, setNotice]);

  /* ---------------- refresh jobs ---------------- */

  const startRefresh = useCallback(async (target: RefreshScope, force = true) => {
    setRefreshError(null);
    try {
      const result = await run("refresh.start", { ...target, force });
      const job = jobFromResult(result);
      if (job) setRefreshJob(job);
      else {
        const latest = await apiGet<RefreshJobDTO | null>("/api/refresh");
        setRefreshJob(latest);
      }
    } catch (error) {
      if (!(isApiError(error) && error.isUnauthenticated)) setRefreshError(errorMessage(error, "The refresh could not be started."));
    }
  }, [run]);

  const cancelRefresh = useCallback(async () => {
    const job = refreshJob;
    if (!job) return;
    try {
      const result = await run("refresh.cancel", { id: job.id });
      const updated = jobFromResult(result);
      setRefreshJob(updated && updated.id === job.id ? updated : { ...job, status: "cancelled", finishedAt: Math.floor(Date.now() / 1000) });
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

  const persistKey = `${viewKey(view)}|${normalizeFocus(view.hasFocus)}|${view.previous}`;
  // Data presence gates the first save until the server view is known; later data changes do not save.
  const hasData = Boolean(data);
  useEffect(() => {
    if (!options.persistView || !hasData) return;
    const target = viewRef.current;
    const timer = setTimeout(() => {
      command("view.save", {
        section: target.section, previous: target.previous, groupId: target.groupId, feedId: target.feedId,
        search: target.search, hasFocus: normalizeFocus(target.hasFocus), showFeeds: target.showFeeds,
        showRead: target.showRead, hotStart: target.hotStart, hotRange: target.hotRange,
      }).catch((error) => {
        if (!(isApiError(error) && error.isUnauthenticated)) setNotice({ kind: "error", text: `Your reading position could not be saved: ${errorMessage(error)}` });
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [persistKey, options.persistView, hasData, setNotice]);

  // Flush queued reads when the page is hidden or unloaded.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flushReads(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushReads);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushReads);
    };
  }, [flushReads]);

  const setFocus = useCallback((focus: string) => {
    if (viewRef.current.hasFocus === focus) return;
    setView({ ...viewRef.current, hasFocus: focus });
  }, [setView]);

  const sectionChange = useCallback((section: Section) => navigate({ section, feedId: 0, hasFocus: "groups" }), [navigate]);

  return useMemo(() => ({
    view, data, list, loading, pageLoading, viewError, pageError, expired, refreshJob, refreshError,
    notice, pendingFresh,
    setNotice, navigate, reload, bootstrap, loadView, softReload, showFresh, loadNextPage, takeRestoreScroll, setExtras,
    markRead, markUnread, toggleSave, markScopeRead, undoRecentlyRead, commandThenReload, flushReads,
    startRefresh, cancelRefresh, setFocus, sectionChange, setView, run,
  }), [view, data, list, loading, pageLoading, viewError, pageError, expired, refreshJob, refreshError, notice, pendingFresh,
    setNotice, navigate, reload, bootstrap, loadView, softReload, showFresh, loadNextPage, takeRestoreScroll, setExtras, markRead, markUnread,
    toggleSave, markScopeRead, undoRecentlyRead, commandThenReload, flushReads, startRefresh, cancelRefresh, setFocus,
    sectionChange, setView, run]);
}

export type ReaderStore = ReturnType<typeof useReader>;

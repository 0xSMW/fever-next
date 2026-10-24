"use client";
import { useCallback, useMemo } from "react";
import type { FeedDTO, GroupDTO, HotLinkDTO, ItemDTO, Section, SharingService } from "@/lib/contracts";
import { apiPost, appHref, errorMessage, isApiError } from "@/lib/client/api";
import { HOT_RANGE_OPTIONS, HOT_START_OPTIONS, feedTitle, groupTitle } from "@/lib/client/format";
import { htmlToText } from "@/lib/client/safe-html";
import { prepareService } from "@/lib/client/services";
import { openExternal } from "./external";
import type { PreferencesSaveInput } from "@/lib/command-contract";
import { groupUnread, kindlingUnread, sparksUnread } from "./model";
import type { ManagementKind } from "@/components/manage/types";
import type { MenuItem } from "./ui";
import type { ReadScope, ReaderStore } from "./useReader";

export type { ManagementKind } from "@/components/manage/types";

export type ReaderDialogRequest =
  | { kind: "membership"; feedId: number }
  | { kind: "keyboard" };

export interface ManagementTarget { feed?: FeedDTO; group?: GroupDTO; link?: HotLinkDTO; }
export type OpenManagement = (kind: ManagementKind, target?: ManagementTarget) => void;

export interface ControllerDeps {
  store: ReaderStore;
  openManagement: OpenManagement;
  openDialog: (request: ReaderDialogRequest) => void;
  signOut: () => void;
  compact: boolean;
  setCompact: (value: boolean) => void;
}

export function useReaderController({ store, openManagement, openDialog, signOut, compact, setCompact }: ControllerDeps) {
  const { view, data } = store;
  const feeds = useMemo(() => data?.feeds ?? [], [data]);
  const groups = useMemo(() => data?.groups ?? [], [data]);
  const preferences = data?.preferences;
  const feedById = useCallback((id: number) => feeds.find((feed) => feed.id === id), [feeds]);
  const groupById = useCallback((id: number) => groups.find((group) => group.id === id), [groups]);

  /* ---------------- navigation ---------------- */

  const loadSection = useCallback((section: Section) => {
    store.navigate({ section, feedId: 0, hasFocus: "groups", ...(section === "kindling" ? { groupId: 0 } : {}) });
  }, [store]);

  const loadGroup = useCallback((groupId: number) => {
    store.navigate({ section: "kindling", groupId, feedId: 0, hasFocus: "groups" });
  }, [store]);

  /** reader.js loadFeed: from Hot (or an inline Saved link) pick Kindling or Sparks. */
  const loadFeed = useCallback((feedId: number, inline = false) => {
    const current = store.view;
    const feed = feedById(feedId);
    const patch: Partial<typeof current> = { feedId, hasFocus: "feeds", showFeeds: true };
    if (feed && (current.section === "hot" || (current.section === "saved" && inline))) {
      patch.section = feed.isSpark ? "sparks" : "kindling";
      const inGroup = current.groupId && (feed.groupIds.includes(current.groupId) || groupById(current.groupId)?.feedIds.includes(feedId));
      patch.groupId = inGroup ? current.groupId : 0;
      patch.showRead = true;
    }
    if (feedId === 0) patch.hasFocus = "feeds";
    store.navigate(patch);
  }, [feedById, groupById, store]);

  const setHotWindow = useCallback((hotStart: number, hotRange: number) => {
    store.navigate({ section: "hot", hotStart, hotRange, hasFocus: "groups" });
  }, [store]);

  const toggleFeeds = useCallback(() => store.navigate({ showFeeds: !store.view.showFeeds }, { history: "replace" }), [store]);
  const toggleRead = useCallback(() => store.navigate({ showRead: !store.view.showRead }, { history: "replace" }), [store]);

  const search = useCallback((term: string) => {
    const value = term.trim();
    store.navigate({ section: "search", search: value, feedId: 0, hasFocus: "groups" });
  }, [store]);

  /** reader.js clearSearch: leave Search for the previous section. */
  const clearSearch = useCallback(() => {
    const current = store.view;
    if (current.section === "search") {
      const previous = current.previous === "search" ? "kindling" : current.previous;
      store.navigate({ section: previous, search: "", feedId: 0, hasFocus: "groups" });
    } else if (current.search) {
      store.navigate({ search: "" }, { history: "replace" });
    }
  }, [store]);

  /* ---------------- reading ---------------- */

  const activeScope = useCallback((): ReadScope | null => {
    const current = store.view;
    if (current.section !== "kindling" && current.section !== "sparks") return null;
    if (current.hasFocus !== "groups" && current.showFeeds && current.feedId) return { scope: "feed", id: current.feedId };
    if (current.section === "sparks") return { scope: "sparks" };
    return current.groupId ? { scope: "group", id: current.groupId } : { scope: "all" };
  }, [store]);

  const markActiveRead = useCallback(() => {
    const scope = activeScope();
    if (scope) void store.markScopeRead(scope);
  }, [activeScope, store]);

  /** Shift+A: group 0 across all feeds; Sparks section uses group -1 as in reader.js. */
  const markAllRead = useCallback(() => {
    void store.markScopeRead(store.view.section === "sparks" ? { scope: "sparks" } : { scope: "all" });
  }, [store]);

  const refreshActive = useCallback(() => {
    const current = store.view;
    if (current.feedId && current.section !== "hot" && (current.hasFocus !== "groups" || !current.groupId)) void store.startRefresh({ scope: "feed", id: current.feedId });
    else if (current.section === "kindling" && current.groupId) void store.startRefresh({ scope: "group", id: current.groupId });
    else void store.startRefresh({ scope: "all" });
  }, [store]);

  const refreshGroup = useCallback((groupId: number) => {
    void store.startRefresh(groupId ? { scope: "group", id: groupId } : { scope: "all" });
  }, [store]);
  const refreshFeed = useCallback((feedId: number) => {
    void store.startRefresh({ scope: "feed", id: feedId });
  }, [store]);

  const visitFeed = useCallback((feedId: number, markFeedRead = false) => {
    const feed = feedById(feedId);
    if (!feed) return;
    if (markFeedRead) void store.markScopeRead({ scope: "feed", id: feedId });
    if (!openExternal(feed.siteUrl || feed.url, preferences)) store.setNotice({ kind: "error", text: "This feed has no valid site address." });
  }, [feedById, preferences, store]);

  const openItem = useCallback((url: string, itemId?: number) => {
    if (itemId) store.markRead([itemId]);
    if (!openExternal(url, preferences)) store.setNotice({ kind: "error", text: "This link is not a web address Fever can open." });
  }, [preferences, store]);

  const editActive = useCallback(() => {
    const current = store.view;
    if (current.hasFocus !== "groups" && current.showFeeds && current.feedId) {
      const feed = feedById(current.feedId);
      if (feed) openManagement("edit-feed", { feed });
    } else if (current.section === "kindling" && current.groupId) {
      const group = groupById(current.groupId);
      if (group) openManagement("edit-group", { group });
    } else if (current.section === "sparks") openManagement("edit-sparks");
  }, [feedById, groupById, openManagement, store]);

  const shareItem = useCallback(async (item: ItemDTO, service: SharingService) => {
    const prepared = prepareService(service, { title: item.title, url: item.url, excerpt: item.excerpt || htmlToText(item.html) });
    if (!prepared.href) { store.setNotice({ kind: "error", text: `${service.name}: ${prepared.reason}` }); return; }
    if (prepared.background) {
      // The server expands the stored template, sends it, and reports the result.
      if (!service.id) { store.setNotice({ kind: "error", text: `${service.name}: save Preferences before sending in the background.` }); return; }
      try {
        const result = await apiPost<{ delivered?: boolean }>("/api/share", { serviceId: service.id, itemId: item.id });
        store.setNotice(result.delivered ? { kind: "info", text: `Sent to ${service.name}.` } : { kind: "error", text: `${service.name} did not confirm delivery.` });
      } catch (error) {
        if (!(isApiError(error) && error.isUnauthenticated)) store.setNotice({ kind: "error", text: `${service.name}: ${errorMessage(error)}` });
      }
      return;
    }
    if (prepared.href.startsWith("mailto:")) { window.location.assign(prepared.href); return; }
    window.open(prepared.href, "_blank", preferences?.anonymize ? "noopener,noreferrer" : "noopener");
  }, [preferences, store]);

  /* ---------------- membership ---------------- */

  const setSpark = useCallback(async (feedId: number, isSpark: boolean) => {
    const feed = feedById(feedId);
    if (!feed) return;
    await store.commandThenReload("feed.update", { id: feed.id, url: feed.url, isSpark }, isSpark ? `${feedTitle(feed)} is now a Spark.` : `${feedTitle(feed)} is back in Kindling.`);
  }, [feedById, store]);

  const addToGroup = useCallback(async (feedId: number, groupId: number) => {
    const feed = feedById(feedId);
    const group = groupById(groupId);
    if (!feed || !group) return;
    if (group.feedIds.includes(feedId) || feed.groupIds.includes(groupId)) {
      store.setNotice({ kind: "info", text: `${feedTitle(feed)} is already in ${groupTitle(group)}.` });
      return;
    }
    await store.commandThenReload("membership.add", { feedId, groupId }, `Added ${feedTitle(feed)} to ${groupTitle(group)}.`);
  }, [feedById, groupById, store]);

  const removeFromGroup = useCallback(async (feedId: number, groupId: number) => {
    const feed = feedById(feedId);
    const group = groupById(groupId);
    if (!feed || !group) return;
    await store.commandThenReload("membership.remove", { feedId, groupId }, `Removed ${feedTitle(feed)} from ${groupTitle(group)}.`);
  }, [feedById, groupById, store]);

  /** Membership dialog: apply each change; failures stop and are reported. */
  const applyMembership = useCallback(async (feedId: number, changes: { add: number[]; remove: number[]; spark: boolean | null }) => {
    const feed = feedById(feedId);
    if (!feed) return;
    for (const groupId of changes.add) await store.run("membership.add", { feedId, groupId });
    for (const groupId of changes.remove) await store.run("membership.remove", { feedId, groupId });
    if (changes.spark !== null) await store.run("feed.update", { id: feed.id, url: feed.url, isSpark: changes.spark });
    await store.reload();
    store.setNotice({ kind: "info", text: `Updated groups for ${feedTitle(feed)}.` });
  }, [feedById, store]);

  /** Drop handling from reader.js makeFeedsDraggable onDragEnd. */
  const dropFeed = useCallback((feedId: number, target: { kind: "group"; id: number } | { kind: "sparks" } | { kind: "remove" }) => {
    const current = store.view;
    if (target.kind === "sparks") void setSpark(feedId, true);
    else if (target.kind === "remove") {
      if (current.section === "sparks") void setSpark(feedId, false);
      else if (current.groupId) void removeFromGroup(feedId, current.groupId);
    } else if (target.id && target.id !== current.groupId) void addToGroup(feedId, target.id);
  }, [addToGroup, removeFromGroup, setSpark, store]);

  /** add-to-blacklist: the management blacklist editor, prefilled with the link. */
  const blacklistLink = useCallback((link: HotLinkDTO) => openManagement("blacklist", { link }), [openManagement]);

  /* ---------------- menus ---------------- */

  const preferencesSave = useCallback((patch: PreferencesSaveInput, success?: string) => store.commandThenReload("preferences.save", patch, success), [store]);

  const actionMenu = useCallback((): MenuItem[] => {
    const current = store.view;
    const which = current.hasFocus !== "groups" && current.showFeeds && current.feedId ? "feed" : current.section === "sparks" ? "Sparks" : "group";
    const scope = activeScope();
    let unread = 0;
    if (scope?.scope === "feed") unread = feedById(scope.id)?.unreadCount ?? 0;
    else if (scope?.scope === "group") unread = groupById(scope.id) ? groupUnread(groupById(scope.id)!, feeds) : 0;
    else if (scope) unread = scope.scope === "sparks" ? sparksUnread(feeds) : kindlingUnread(feeds);
    return [
      { label: "Unread most recently read", shortcut: "z", onSelect: () => void store.undoRecentlyRead() },
      { label: `Mark current ${which} as read`, shortcut: "a", disabled: !scope || unread === 0, onSelect: markActiveRead },
      { label: "Refresh all", shortcut: "r", onSelect: () => void store.startRefresh({ scope: "all" }) },
      "divider",
      { label: "Show read", shortcut: "u", checked: current.showRead, disabled: current.section === "saved" || current.section === "search", onSelect: toggleRead },
      { label: "Show feeds", shortcut: "f", checked: current.showFeeds, onSelect: toggleFeeds },
      { label: "Fluid width", checked: preferences?.layout === 1, disabled: !preferences, onSelect: () => void preferencesSave({ layout: preferences?.layout === 1 ? 0 : 1 }) },
      { label: "Compact layout", checked: compact, onSelect: () => setCompact(!compact) },
      "divider",
      { label: "New group…", shortcut: "n", shift: true, onSelect: () => openManagement("add-group") },
      { label: "New feed…", shortcut: "n", onSelect: () => openManagement("add-feed") },
      "divider",
      { label: "Import…", onSelect: () => openManagement("import") },
      { label: "Export…", onSelect: () => openManagement("export") },
      "divider",
      { label: "Preferences…", shortcut: "p", onSelect: () => openManagement("preferences") },
      { label: "Blacklist…", shortcut: "b", shift: true, onSelect: () => openManagement("blacklist") },
      "divider",
      { label: "Release notes…", onSelect: () => window.location.assign(appHref("/updated")) },
      { label: "Keyboard shortcuts…", shortcut: "?", onSelect: () => openDialog({ kind: "keyboard" }) },
      { label: "Extras…", onSelect: () => window.location.assign(appHref("/extras")) },
      { label: "Diagnostics…", onSelect: () => window.location.assign(appHref("/diagnostics")) },
      { label: "Logout", onSelect: signOut },
      "divider",
      { label: "Maintenance…", onSelect: () => openManagement("maintenance") },
    ];
  }, [activeScope, compact, feedById, feeds, groupById, markActiveRead, openDialog, openManagement, preferences, preferencesSave, setCompact, signOut, store, toggleFeeds, toggleRead]);

  const groupMenu = useCallback((groupId: number): MenuItem[] => {
    const group = groupById(groupId);
    const unread = groupId === 0 ? kindlingUnread(feeds) : group ? groupUnread(group, feeds) : 0;
    return [
      { label: "Mark group as read", disabled: unread === 0, onSelect: () => void store.markScopeRead(groupId ? { scope: "group", id: groupId } : { scope: "all" }) },
      { label: "Refresh group", onSelect: () => void store.startRefresh(groupId ? { scope: "group", id: groupId } : { scope: "all" }) },
      "divider",
      { label: "Edit…", shortcut: "i", disabled: !group, onSelect: () => group && openManagement("edit-group", { group }) },
      "divider",
      { label: "Delete…", disabled: !group, onSelect: () => group && openManagement("delete-group", { group }) },
    ];
  }, [feeds, groupById, openManagement, store]);

  const sparksMenu = useCallback((): MenuItem[] => {
    const unread = sparksUnread(feeds);
    return [
      { label: "Mark Sparks as read", disabled: unread === 0, onSelect: () => void store.markScopeRead({ scope: "sparks" }) },
      { label: "Edit…", shortcut: "i", onSelect: () => openManagement("edit-sparks") },
      "divider",
      { label: "Delete…", onSelect: () => openManagement("delete-sparks") },
    ];
  }, [feeds, openManagement, store]);

  const feedMenu = useCallback((feedId: number): MenuItem[] => {
    const feed = feedById(feedId);
    if (!feed) return [{ label: "This feed is no longer available", disabled: true }];
    const current = store.view;
    const inCustomGroup = current.section === "kindling" && current.groupId > 0;
    const items: MenuItem[] = [
      { label: "Mark feed as read", disabled: feed.unreadCount === 0 || current.section === "saved", onSelect: () => void store.markScopeRead({ scope: "feed", id: feedId }) },
      { label: "Refresh feed", onSelect: () => void store.startRefresh({ scope: "feed", id: feedId }) },
      "divider",
      { label: "Visit site…", shortcut: "v", onSelect: () => visitFeed(feedId) },
      { label: "Visit site and mark as read…", shortcut: "v", shift: true, onSelect: () => visitFeed(feedId, true) },
      "divider",
      { label: "Edit…", shortcut: "i", onSelect: () => openManagement("edit-feed", { feed }) },
    ];
    if (feed.requiresAuth) items.push({ label: "Authenticate…", onSelect: () => openManagement("auth-feed", { feed }) });
    items.push(
      { label: "Groups…", onSelect: () => openDialog({ kind: "membership", feedId }) },
      feed.isSpark
        ? { label: "Remove from Sparks", onSelect: () => void setSpark(feedId, false) }
        : { label: "Move to Sparks", onSelect: () => void setSpark(feedId, true) },
    );
    if (inCustomGroup && !feed.isSpark) {
      const group = groupById(current.groupId);
      if (group) items.push({ label: `Remove from ${groupTitle(group)}`, onSelect: () => void removeFromGroup(feedId, group.id) });
    }
    items.push("divider", { label: "Unsubscribe…", onSelect: () => openManagement("delete-feed", { feed }) });
    return items;
  }, [feedById, groupById, openDialog, openManagement, removeFromGroup, setSpark, store, visitFeed]);

  const itemMenu = useCallback((item: ItemDTO, isFull: boolean, toggleContent: () => void): MenuItem[] => {
    const services = preferences?.services ?? [];
    const entries: MenuItem[] = [
      { label: "Excerpt", shortcut: "↵", checked: !isFull, onSelect: toggleContent },
      { label: item.isSaved ? "Saved" : "Save", shortcut: "s", checked: item.isSaved, onSelect: () => store.toggleSave(item.id) },
      item.readAt && !item.isSaved
        ? { label: "Mark as unread", onSelect: () => store.markUnread(item.id) }
        : { label: "Mark as read", disabled: item.isSaved || Boolean(item.readAt), onSelect: () => store.markRead([item.id], true) },
      { label: "Open original…", shortcut: "o", onSelect: () => openItem(item.url, item.id) },
    ];
    if (services.length) entries.push("divider");
    for (const service of services) {
      const prepared = prepareService(service, { title: item.title, url: item.url, excerpt: item.excerpt });
      entries.push({
        label: prepared.background ? `${service.name} (in background)` : service.name,
        shortcut: service.key || undefined,
        disabled: !prepared.href,
        title: prepared.reason,
        onSelect: () => void shareItem(item, service),
      });
    }
    return entries;
  }, [openItem, preferences, shareItem, store]);

  const hotRangeMenu = useCallback((): MenuItem[] => HOT_RANGE_OPTIONS.map((entry) => entry === null ? "divider" : {
    label: entry[1], checked: store.view.hotRange === entry[0], onSelect: () => setHotWindow(store.view.hotStart, entry[0]),
  }), [setHotWindow, store]);
  const hotStartMenu = useCallback((): MenuItem[] => HOT_START_OPTIONS.map((entry) => entry === null ? "divider" : {
    label: entry[1], checked: store.view.hotStart === entry[0], onSelect: () => setHotWindow(entry[0], store.view.hotRange),
  }), [setHotWindow, store]);

  return {
    view, data, feeds, groups, preferences, feedById, groupById,
    loadSection, loadGroup, loadFeed, setHotWindow, toggleFeeds, toggleRead, search, clearSearch,
    activeScope, markActiveRead, markAllRead, refreshActive, refreshGroup, refreshFeed, visitFeed, openItem, editActive, shareItem,
    setSpark, addToGroup, removeFromGroup, applyMembership, dropFeed, blacklistLink, preferencesSave,
    actionMenu, groupMenu, sparksMenu, feedMenu, itemMenu, hotRangeMenu, hotStartMenu,
    errorMessage,
  };
}

export type ReaderController = ReturnType<typeof useReaderController>;

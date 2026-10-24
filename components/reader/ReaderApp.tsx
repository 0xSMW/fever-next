"use client";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import { ManagementDialog } from "@/components/manage/ManagementDialog";
import { isManagementKind } from "@/components/manage/types";
import { loginPath } from "@/components/pages/return-path";
import { BASE_PATH, appHref, errorMessage, getSession, resetSession } from "@/lib/client/api";
import { LOGO_SRC, LOGO_SRC_2X } from "@/lib/client/assets";
import { type LocationState, parseLocation, readerHref } from "@/lib/client/url-state";
import { type ManagementKind, type ManagementTarget, type ReaderDialogRequest, useReaderController } from "./controller";
import { DesktopReader } from "./DesktopReader";
import { KeyboardHelpDialog, MembershipDialog, SessionExpiredDialog } from "./dialogs";
import { kindlingUnread } from "./model";
import { MobileReader } from "./mobile/MobileReader";
import type { MobileSettings } from "./mobile/screens";
import { TextButton } from "./ui";
import { useReader } from "./useReader";

import { createDefaultViewState } from "@/lib/reader-policy";
import { updateFeverHistory } from "@/lib/client/reader-history";

const LAYOUT_KEY = "fever.layout";
const MOBILE_KEY = "fever.mobile";
const COMPACT_QUERY = "(max-width: 767px)";

/**
 * The current page as an app-relative path (base path removed at a path
 * boundary), so the login page's safeReturnPath accepts it as a return target.
 */
function currentAppPath(): string {
  const { pathname, search, hash } = window.location;
  let path = pathname;
  if (BASE_PATH) {
    if (path !== BASE_PATH && !path.startsWith(`${BASE_PATH}/`)) return "/";
    path = path.slice(BASE_PATH.length) || "/";
  }
  return `${path}${search}${hash}`;
}

function loginHref(): string {
  return appHref(loginPath(currentAppPath()));
}

type Boot =
  | { status: "checking" }
  | { status: "redirecting"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; location: LocationState };

/** Client entry: checks /api/session, then routes to setup, login, or the reader. */
export default function ReaderApp() {
  const [boot, setBoot] = useState<Boot>({ status: "checking" });

  // State changes only once the session answers; the initial state is already "checking".
  const requestSession = useCallback(() => {
    getSession(true).then((session) => {
      if (!session.configured) {
        setBoot({ status: "redirecting", message: "Fever is not set up yet. Opening setup…" });
        window.location.replace(appHref("/setup"));
      } else if (!session.authenticated) {
        setBoot({ status: "redirecting", message: "Opening the login page…" });
        window.location.replace(loginHref());
      } else {
        setBoot({ status: "ready", location: parseLocation(window.location.search) });
      }
    }).catch((error) => setBoot({ status: "error", message: errorMessage(error, "Fever could not be reached.") }));
  }, []);

  useEffect(requestSession, [requestSession]);
  const check = () => {
    setBoot({ status: "checking" });
    requestSession();
  };

  if (boot.status !== "ready") {
    return (
      <div className="fever-boot" role={boot.status === "error" ? "alert" : "status"}>
        {/* eslint-disable-next-line @next/next/no-img-element -- fixed-size preserved source asset with its own 2x file */}
        <img src={LOGO_SRC} srcSet={`${LOGO_SRC} 1x, ${LOGO_SRC_2X} 2x`} width={50} height={17} alt="Fever°" />
        <p>{boot.status === "checking" ? "Loading Fever…" : boot.message}</p>
        {boot.status === "error" ? <TextButton primary onClick={check}>Try again</TextButton> : null}
      </div>
    );
  }
  return <ReaderShell location={boot.location} />;
}

function readJson<T>(key: string): T | null {
  try { const raw = window.localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
}
function writeJson(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be disabled; the choice lasts for this page */ }
}

function initialCompact(location: LocationState): { compact: boolean; explicit: boolean } {
  if (location.compact !== null) return { compact: location.compact, explicit: true };
  const stored = readJson<"compact" | "desktop">(LAYOUT_KEY);
  if (stored) return { compact: stored === "compact", explicit: true };
  return { compact: window.matchMedia(COMPACT_QUERY).matches, explicit: false };
}

function ReaderShell({ location }: { location: LocationState }) {
  const [layout, setLayout] = useState(() => initialCompact(location));
  const compact = layout.compact;
  const [mobileSettings, setMobileSettings] = useState<MobileSettings>(() => readJson<MobileSettings>(MOBILE_KEY) ?? { showRead: true, showFeeds: true });
  const overrides = useMemo(() => (compact ? { showRead: mobileSettings.showRead, showFeeds: mobileSettings.showFeeds } : undefined), [compact, mobileSettings]);
  const store = useReader({ ...createDefaultViewState(), ...location.view }, { persistView: !compact, overrides });
  const [manage, setManage] = useState<({ kind: ManagementKind } & ManagementTarget) | null>(null);
  const [dialog, setDialog] = useState<ReaderDialogRequest | null>(null);

  const doSignOut = useCallback(async () => {
    try { await store.flushReads(); } catch { return; }
    resetSession();
    void signOut({ callbackUrl: appHref("/login") });
  }, [store]);

  /** The stored choice persists the layout; drop any one-off compact flag from the URL. */
  const setCompact = useCallback((value: boolean) => {
    writeJson(LAYOUT_KEY, value ? "compact" : "desktop");
    store.setExtras({});
    updateFeverHistory({ extras: {} }, readerHref(store.view, {}));
    setLayout({ compact: value, explicit: true });
  }, [store]);

  const openManagement = useCallback((kind: ManagementKind, target?: ManagementTarget) => {
    setManage({ kind, ...target });
  }, []);

  const ctl = useReaderController({ store, openManagement, openDialog: setDialog, signOut: doSignOut, compact, setCompact });

  // Legacy ?manage links arrive as ?dialog=<kind>; open it once, after feeds and groups load.
  // The first navigation rewrites the URL through readerHref, which drops the dialog parameters.
  const pendingDialog = useRef(location.dialog);
  useEffect(() => {
    const request = pendingDialog.current;
    if (!request || !store.data) return;
    pendingDialog.current = null;
    if (!isManagementKind(request.kind)) {
      store.setNotice({ kind: "error", text: `“${request.kind}” is not a Fever management dialog.` });
      return;
    }
    // A missing feed or group is reported by the dialog itself.
    const feed = request.feedId ? store.data.feeds.find((entry) => entry.id === request.feedId) : undefined;
    const group = request.groupId ? store.data.groups.find((entry) => entry.id === request.groupId) : undefined;
    setManage({ kind: request.kind, feed, group });
  }, [store]);

  // GroupEditor dispatches this after a new group is created: show it in Kindling.
  // loadGroup fetches a fresh view, so the new group and its feeds are included.
  // MobileReader handles the event itself, since it also owns the screen route.
  const { loadGroup } = ctl;
  useEffect(() => {
    if (compact) return;
    const onSelectGroup = (event: Event) => {
      const groupId = (event as CustomEvent<{ groupId?: unknown }>).detail?.groupId;
      if (typeof groupId === "number" && Number.isSafeInteger(groupId) && groupId > 0) loadGroup(groupId);
    };
    window.addEventListener("fever:select-group", onSelectGroup);
    return () => window.removeEventListener("fever:select-group", onSelectGroup);
  }, [compact, loadGroup]);

  // First load: deep link or the server-stored view. Runs once on mount with that render's values.
  const firstLoad = useEffectEvent(() => {
    // Screen and item parameters only describe the compact drill-down.
    const extras = compact
      ? { compact: location.compact, screen: location.screen, itemId: location.itemId || undefined }
      : { compact: location.compact };
    if (location.explicit) store.navigate(location.view, { history: "replace", extras });
    else void store.bootstrap(extras);
  });
  useEffect(() => { firstLoad(); }, []);

  // Follow the viewport unless the reader chose a layout explicitly.
  useEffect(() => {
    if (layout.explicit) return;
    const query = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setLayout({ compact: query.matches, explicit: false });
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [layout.explicit]);

  // Layout or device settings change the query overrides; reload once data exists.
  const overrideKey = `${compact}|${mobileSettings.showRead}|${mobileSettings.showFeeds}`;
  const appliedOverrideKey = useRef(overrideKey);
  const reloadForOverrides = useEffectEvent(() => {
    if (store.data) void store.reload();
  });
  useEffect(() => {
    if (overrideKey === appliedOverrideKey.current) return;
    appliedOverrideKey.current = overrideKey;
    reloadForOverrides();
  }, [overrideKey]);

  useEffect(() => {
    document.documentElement.dataset.layout = compact ? "compact" : "desktop";
    return () => { delete document.documentElement.dataset.layout; };
  }, [compact]);

  // Title count (reader.js updateBadge); Sparks never inflate it.
  const unread = store.data ? kindlingUnread(store.data.feeds) : 0;
  const showCount = Boolean(store.data?.preferences.unreadCounts);
  useEffect(() => {
    document.title = showCount && unread ? `Fever° (${unread})` : "Fever°";
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (showCount && unread && nav.setAppBadge) nav.setAppBadge(unread).catch(() => undefined);
    else if (nav.clearAppBadge) nav.clearAppBadge().catch(() => undefined);
  }, [showCount, unread]);

  const onManagementChanged = useCallback(() => {
    const request = manage;
    const view = store.view;
    if (request?.kind === "delete-feed" && request.feed && view.feedId === request.feed.id) {
      store.navigate({ feedId: 0, hasFocus: "groups" }, { history: "replace" });
      return;
    }
    if (request?.kind === "delete-group" && request.group && view.section === "kindling" && view.groupId === request.group.id) {
      store.navigate({ groupId: 0, feedId: 0, hasFocus: "groups" }, { history: "replace" });
      return;
    }
    void store.reload();
  }, [manage, store]);

  const dialogFeed = dialog?.kind === "membership" ? store.data?.feeds.find((feed) => feed.id === dialog.feedId) : undefined;
  const modalOpen = Boolean(manage || dialog || store.expired);

  return (
    <div className="fever-reader">
      {compact ? (
        <MobileReader
          store={store}
          ctl={ctl}
          openManagement={openManagement}
          initialRoute={{ screen: location.screen, itemId: location.itemId }}
          settings={mobileSettings}
          onSettings={(next) => { writeJson(MOBILE_KEY, next); setMobileSettings(next); }}
          onDesktop={() => setCompact(false)}
          onLogout={doSignOut}
        />
      ) : (
        <DesktopReader store={store} ctl={ctl} openManagement={openManagement} openDialog={setDialog} modalOpen={modalOpen} />
      )}

      {!store.data && store.viewError ? (
        <div className="fever-boot" role="alert">
          <p>{store.viewError}</p>
          <TextButton primary onClick={() => void store.reload()}>Try again</TextButton>
        </div>
      ) : null}
      {!store.data && !store.viewError ? (
        <div className="fever-boot" role="status"><p>Loading Fever…</p></div>
      ) : null}

      {manage ? (
        <ManagementDialog
          request={{ kind: manage.kind, feed: manage.feed, group: manage.group, link: manage.link, view: store.data ?? undefined }}
          onClose={() => setManage(null)}
          onChanged={onManagementChanged}
        />
      ) : null}

      {dialog?.kind === "keyboard" ? <KeyboardHelpDialog services={store.data?.preferences.services ?? []} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "membership" && dialogFeed && store.data ? (
        <MembershipDialog feed={dialogFeed} groups={store.data.groups} onApply={(changes) => ctl.applyMembership(dialogFeed.id, changes)} onClose={() => setDialog(null)} />
      ) : null}
      {store.expired ? <SessionExpiredDialog onLogin={() => window.location.assign(loginHref())} /> : null}
    </div>
  );
}

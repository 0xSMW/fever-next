"use client";

import "./manage.css";
import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useIsClient } from "@/lib/client/hydration";
import type { ReaderView } from "@/lib/contracts";
import { BlacklistEditor } from "./Blacklist";
import { AuthFeed, DeleteFeed, FeedEditor } from "./FeedForms";
import { DeleteGroup, DeleteSparks, EditSparks, GroupEditor } from "./GroupForms";
import { MaintenanceForm } from "./Maintenance";
import { ExportOpml, ImportOpml } from "./Opml";
import { PreferencesForm } from "./Preferences";
import { Button, ErrorBanner, Footer, Frame, Loading, PanelContext, type PanelContextValue } from "./shared";
import {
  isManagementKind, type ManagementDialogProps, type ManagementKind, type ManagementPanelProps, type ManagementRequest,
} from "./types";
import { useReaderData } from "./useReaderData";

export type {
  ManagementDialogProps, ManagementKind, ManagementPanelProps, ManagementRequest, MaintenanceOperation, PreferenceTab,
} from "./types";
export { MANAGEMENT_KINDS, MAINTENANCE_OPERATIONS, PREFERENCE_TABS, isManagementKind } from "./types";

/** Kinds that work without feeds, groups or preferences. */
const VIEWLESS: readonly ManagementKind[] = ["import", "maintenance"];

function requestKey(request: ManagementRequest) {
  return `${request.kind}:${request.feed?.id ?? ""}:${request.group?.id ?? ""}:${request.operation ?? ""}:${request.tab ?? ""}`;
}

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((node) => !node.closest("[hidden]") && node.getClientRects().length > 0);
}

/**
 * Every Fever management form. The reader uses ManagementDialog; standalone
 * pages (blacklist, maintenance, extras) render this directly.
 */
export function ManagementPanel(props: ManagementPanelProps) {
  return <PanelBody {...props} />;
}

function PanelBody({ request, onClose, onChanged, standalone = false, modalRef }: ManagementPanelProps & { modalRef?: RefObject<HTMLDivElement | null> }) {
  const titleId = useId();
  const key = requestKey(request);
  // A navigation belongs to the request it started from; a new request drops it.
  const [navigation, setNavigation] = useState<{ key: string; request: ManagementRequest | null }>(() => ({ key, request: null }));
  if (navigation.key !== key) setNavigation({ key, request: null });
  const [busy, setBusy] = useState(0);
  const [blockedClose, setBlockedClose] = useState(false);
  const busyRef = useRef(0);

  const current = (navigation.key === key ? navigation.request : null) ?? request;
  const kind = current.kind;
  const needsView = isManagementKind(kind) && !VIEWLESS.includes(kind);
  const providedView: ReaderView | undefined = current.view ?? request.view;
  const data = useReaderData(providedView, needsView);
  const view = providedView ?? data.view;
  const { reload } = data;

  const trackBusy = useCallback((delta: 1 | -1) => {
    busyRef.current = Math.max(0, busyRef.current + delta);
    setBusy(busyRef.current);
    if (busyRef.current === 0) setBlockedClose(false);
  }, []);

  /** Cancel never mutates; while a request runs, closing waits for it. */
  const close = useCallback(() => {
    if (busyRef.current > 0) { setBlockedClose(true); return; }
    onClose();
  }, [onClose]);

  const changed = useCallback(async () => {
    await onChanged();
    if (!providedView && needsView) await reload();
  }, [onChanged, providedView, needsView, reload]);

  const navigate = useCallback((next: ManagementRequest) => {
    setNavigation({ key, request: { ...next, view: next.view ?? view } });
  }, [key, view]);

  const context = useMemo<PanelContextValue>(
    () => ({ close, changed, navigate, trackBusy, titleId, standalone }),
    [close, changed, navigate, trackBusy, titleId, standalone],
  );

  let body: ReactNode;
  if (!isManagementKind(kind)) {
    body = <Problem message={`“${kind}” is not a Fever management dialog.`} />;
  } else if (needsView && !view) {
    body = data.error
      ? <Problem message={data.error.message} retry={() => void reload()} />
      : <Frame title="Loading" size="small" footer={<Footer />}><Loading label="Loading your feeds and groups…" /></Frame>;
  } else {
    body = renderKind(kind, current, view);
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = modalRef?.current;
    if (!root || event.nativeEvent.isComposing) return;
    // Reader shortcuts must not act on the page behind the dialog.
    event.stopPropagation();
    // Escape on a native select closes its dropdown, not the dialog.
    if (event.key === "Escape" && event.target instanceof HTMLSelectElement) return;
    if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key === ".")) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = focusables(root);
    if (nodes.length === 0) { event.preventDefault(); root.focus(); return; }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const content = (
    <>
      {blockedClose && busy > 0 && <p className="fm-blocked" role="status">Wait for the current request to finish before closing.</p>}
      {body}
    </>
  );

  return (
    <PanelContext.Provider value={context}>
      {modalRef ? (
        <div ref={modalRef} className="fm-root fm-dialog" data-kind={kind} role="dialog" aria-modal="true" aria-labelledby={titleId}
          aria-busy={busy > 0 || undefined} tabIndex={-1} onKeyDown={onKeyDown}>
          {content}
        </div>
      ) : (
        <div className={`fm-root${standalone ? " fm-standalone" : ""}`} data-kind={kind} aria-busy={busy > 0 || undefined}>
          {content}
        </div>
      )}
    </PanelContext.Provider>
  );
}

function Problem({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Frame title="Fever" size="small" footer={<Footer cancelLabel="Close" extra={retry ? <Button onClick={retry}>Try again</Button> : undefined} />}>
      <ErrorBanner error={{ message, fields: {} }} />
    </Frame>
  );
}

function renderKind(kind: ManagementKind, request: ManagementRequest, loaded: ReaderView | undefined) {
  const feedId = request.feed?.id;
  const groupId = request.group?.id;
  const feed = feedId === undefined ? undefined : loaded?.feeds.find((entry) => entry.id === feedId) ?? request.feed;
  const group = groupId === undefined ? undefined : loaded?.groups.find((entry) => entry.id === groupId) ?? request.group;
  const missingFeed = <Problem message="That feed no longer exists. It may have been removed in another window." />;
  const missingGroup = <Problem message="That group no longer exists. It may have been removed in another window." />;
  const formKey = requestKey(request);

  if (kind === "import") return <ImportOpml key={formKey} />;
  if (kind === "maintenance") return <MaintenanceForm key={formKey} initialOperation={request.operation} />;
  // Every other kind is rendered only after the view has loaded.
  const view = loaded as ReaderView;

  switch (kind) {
    case "preferences":
      return <PreferencesForm key={formKey} view={view} initialTab={request.tab} />;
    case "add-feed":
      return <FeedEditor key={formKey} mode="add" view={view} />;
    case "edit-feed":
      return feed ? <FeedEditor key={formKey} mode="edit" feed={feed} view={view} initialTab={feed.requiresAuth ? "authentication" : "feed"} /> : missingFeed;
    case "delete-feed":
      return feed ? <DeleteFeed key={formKey} feed={feed} view={view} /> : missingFeed;
    case "auth-feed":
      return feed ? <AuthFeed key={formKey} feed={feed} /> : missingFeed;
    case "add-group":
      return <GroupEditor key={formKey} mode="add" view={view} />;
    case "edit-group":
      return group && group.id > 0 ? <GroupEditor key={formKey} mode="edit" group={group} view={view} /> : missingGroup;
    case "delete-group":
      return group && group.id > 0 ? <DeleteGroup key={formKey} group={group} view={view} /> : missingGroup;
    case "edit-sparks":
      return <EditSparks key={formKey} view={view} />;
    case "delete-sparks":
      return <DeleteSparks key={formKey} view={view} />;
    case "blacklist":
      return <BlacklistEditor key={formKey} initialRules={view.preferences.blacklist ?? ""} link={request.link?.url} />;
    case "export":
      return <ExportOpml key={formKey} view={view} />;
  }
}

/**
 * Modal wrapper used by the reader. Traps focus, closes on Escape or
 * Cmd/Ctrl+period, refuses to close while a request is in flight, and returns
 * focus to the control that opened it.
 */
export function ManagementDialog({ request, onClose, onChanged }: ManagementDialogProps) {
  const mounted = useIsClient();
  const dialog = useRef<HTMLDivElement | null>(null);
  // Read on the first render, before the dialog's own controls can take focus.
  const [opener] = useState(() => (
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null
  ));

  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (opener && opener.isConnected) requestAnimationFrame(() => opener.focus());
    };
  }, [opener]);

  // Place focus initially, and again whenever the form is replaced
  // (loading → form, duplicate feed → edit feed) and focus was lost.
  useEffect(() => {
    const root = dialog.current;
    if (!mounted || !root) return;
    const place = () => {
      const target = root.querySelector<HTMLElement>("[data-autofocus]:not([disabled])")
        ?? focusables(root).find((node) => node.closest(".fm-body"))
        ?? focusables(root)[0];
      (target ?? root).focus();
    };
    place();
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !root.contains(active)) place();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [mounted]);

  if (!mounted) return null;

  return createPortal(
    <div className="fm-overlay">
      <PanelBody request={request} onClose={onClose} onChanged={onChanged} modalRef={dialog} />
    </div>,
    document.body,
  );
}

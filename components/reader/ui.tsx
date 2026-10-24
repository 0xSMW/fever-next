"use client";
import { type ReactNode, useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import type { FeedDTO } from "@/lib/contracts";
import { appHref } from "@/lib/client/api";

/** The sliding-door frame from the source markup; purely decorative. */
export function Frame() {
  return <s className="box" aria-hidden="true"><u><u /></u><i><i /></i><b><b /></b></s>;
}

export function Favicon({ feed, className = "" }: { feed?: Pick<FeedDTO, "faviconId" | "requiresAuth"> | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  const locked = Boolean(feed?.requiresAuth);
  if (!feed || feed.faviconId <= 1 || failed || locked) {
    return <i className={`favicon icon${locked ? " locked" : ""} ${className}`} aria-hidden="true"><i /></i>;
  }
  return (
    <i className={`favicon ${className}`} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- favicons come from the protected same-origin favicon endpoint */}
      <img src={appHref(`/api/favicons/${feed.faviconId}`)} alt="" width={16} height={16} onError={() => setFailed(true)} />
    </i>
  );
}

/** "btn text" pill button from shared.css. */
export function TextButton({ children, onClick, primary, disabled, type = "button", title }: {
  children: ReactNode; onClick?: () => void; primary?: boolean; disabled?: boolean; type?: "button" | "submit"; title?: string;
}) {
  return (
    <button type={type} className="text-button" onClick={onClick} disabled={disabled} title={title}>
      <span className={`btn text${primary ? " default" : ""}`}>{children}<i /></span>
    </button>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ---------------- menus ---------------- */

export interface MenuEntry {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Checkmark state for toggles and selected options. */
  checked?: boolean;
  shortcut?: string;
  shift?: boolean;
  title?: string;
}
export type MenuItem = MenuEntry | "divider";

export interface MenuRequest { anchor: HTMLElement; label: string; items: MenuItem[]; }

export function MenuPopup({ request, onClose }: { request: MenuRequest; onClose: () => void }) {
  const menuRef = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const anchor = request.anchor;

  // fever.js displayMenu: open over the button (top minus the 4px list
  // padding), then shift up or left to stay 24px inside the window.
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const menu = menuRef.current;
    const width = menu?.offsetWidth ?? 200;
    const height = menu?.offsetHeight ?? 200;
    const safety = 24;
    let top = rect.top - 4;
    let left = rect.left;
    if (top + height + safety > window.innerHeight) top = window.innerHeight - height - safety;
    if (left + width + safety > window.innerWidth) left = window.innerWidth - width - safety;
    setPosition({ top: Math.max(8, top), left: Math.max(8, left) });
  }, [anchor, request.items.length]);

  const enabledButtons = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);

  useEffect(() => {
    enabledButtons()[0]?.focus();
    const close = () => onClose();
    // A long menu scrolls inside #menu-options; only outside scrolling closes it.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
      if (anchor.isConnected) anchor.focus();
    };
  }, [anchor, onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = enabledButtons();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") { event.preventDefault(); buttons[(index + 1) % buttons.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); buttons[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); buttons[buttons.length - 1]?.focus(); }
    else if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); onClose(); }
  };

  return (
    <div id="menu-container" className="open" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div id="menu" style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}>
        <ul id="menu-options" role="menu" aria-label={request.label} ref={menuRef} onKeyDown={onKeyDown}>
          {request.items.map((item, index) => item === "divider"
            ? <li key={`d${index}`} className="divider" role="separator" />
            : (
              <li key={`${item.label}${index}`} role="none" className={`${item.checked ? "selected" : ""}${item.disabled ? " disabled" : ""}`}>
                <button
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={item.checked === undefined ? undefined : item.checked}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => { onClose(); item.onSelect?.(); }}
                >
                  {item.label}
                  {item.shortcut ? <span className={`key${item.shift ? " shift" : ""}`} aria-hidden="true">{item.shortcut}</span> : null}
                  {item.shortcut ? <span className="sr-only">, shortcut {item.shift ? "Shift " : ""}{item.shortcut}</span> : null}
                </button>
              </li>
            ))}
        </ul>
        <div id="menu-shadow" aria-hidden="true" />
      </div>
    </div>
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const open = useCallback((anchor: HTMLElement, label: string, items: MenuItem[]) => setMenu({ anchor, label, items }), []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

/** Sprite menu button (action/group/feed/item). */
export function MenuButton({ kind, label, onOpen }: { kind: "action" | "group" | "feed" | "item"; label: string; onOpen: (anchor: HTMLElement) => void }) {
  return (
    <button
      type="button"
      className={`btn menu ${kind}`}
      aria-haspopup="menu"
      aria-label={label}
      title={label}
      onClick={(event) => { event.stopPropagation(); onOpen(event.currentTarget); }}
    >{label}</button>
  );
}

/* ---------------- help bubbles ---------------- */

export const HELP_TEXT: Record<string, { title: string; body: string }> = {
  hot: {
    title: "Hot",
    body: "Links from all of your feeds are weighted by frequency and disposition of the linking feed, then ordered by temperature using the normal body temperature as a base.",
  },
  kindling: { title: "Kindling", body: "Kindling is a supergroup containing all of your non-Spark feeds. These are your must-reads." },
  saved: {
    title: "Saved",
    body: "Unlike other items, which are deleted when they expire, saved items are kept until you unsubscribe from the item's feed. See the Sharing tab in Preferences to publish an RSS feed of your saved items.",
  },
  sparks: {
    title: "Sparks",
    body: "Sparks are inessential feeds that increase the temperature of links in the Hot view. Their unread items never appear in Kindling or in your custom groups. Link blogs and sites that frequently repost content are good candidates.",
  },
  "all-items": { title: "All items in this group", body: "A steady stream of items from all feeds in this group." },
};

export function HelpButton({ topic, celsius }: { topic: keyof typeof HELP_TEXT | string; celsius?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; dangleTop: number; dangleLeft: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const help = HELP_TEXT[topic];
  const show = () => setOpen(true);
  const hide = () => { if (timer.current) clearTimeout(timer.current); setOpen(false); setPos(null); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // fever.js displayHelp: bubble 17px right of the button, centred on it
  // (at least 12px from the top); the dangle sits 4px left and 16px above.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    const bubble = bubbleRef.current;
    if (!rect || !bubble) return;
    const top = Math.max(12, rect.top - bubble.offsetHeight / 2 + rect.height / 2);
    const left = Math.min(rect.left + 17, window.innerWidth - bubble.offsetWidth - 8);
    setPos({ top, left, dangleTop: rect.top - 16, dangleLeft: rect.left - 4 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!help) return null;
  const body = topic === "hot" ? `${help.body.replace("the normal body temperature", `the normal body temperature of ${celsius ? "37" : "98.6"}°`)}` : help.body;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn help"
        aria-label={`About ${help.title}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => { timer.current = setTimeout(show, 500); }}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(event) => { event.stopPropagation(); if (open) hide(); else show(); }}
      >Help</button>
      {open ? (
        <>
          <div ref={bubbleRef} className="help-bubble" role="tooltip" id={id}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}>
            <dl><dt>{help.title}</dt><dd>{body}</dd></dl>
          </div>
          {pos ? <div className="help-dangle" aria-hidden="true" style={{ top: pos.dangleTop, left: pos.dangleLeft }} /> : null}
        </>
      ) : null}
    </>
  );
}

/* ---------------- dialogs ---------------- */

const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";

/** Focus trap, Escape and Cmd/Ctrl+period dismissal, and focus return. */
export function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, without reinstalling the trap (and moving focus) when it changes.
  const close = useEffectEvent(() => onClose());
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key === ".")) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem.focus(); }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return ref;
}

export function ReaderDialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useDialogFocus(onClose);
  const titleId = useId();
  return (
    <div id="dialog-container" className="open" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div id="dialog-window" className={wide ? "wide" : undefined}>
        <div id="dialog" className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
          <h1 id={titleId}>{title}</h1>
          <div className="dialog-body">{children}</div>
        </div>
      </div>
    </div>
  );
}

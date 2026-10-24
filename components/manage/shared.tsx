"use client";

import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode,
} from "react";
import { errorMessage, isApiError } from "@/lib/client/api";
import type { DisplayOptions, Preferences } from "@/lib/contracts";
import type { ManagementRequest } from "./types";

/* ------------------------------------------------------------------ context */

export interface PanelContextValue {
  /** Close without any further mutation. */
  close: () => void;
  /** Ask the reader to reload its view after a successful mutation. */
  changed: () => Promise<void>;
  /** Replace the current form (for example duplicate feed → edit feed). */
  navigate: (request: ManagementRequest) => void;
  /** Mark a request in flight; closing is refused while any request runs. */
  trackBusy: (delta: 1 | -1) => void;
  titleId: string;
  standalone: boolean;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const value = useContext(PanelContext);
  if (!value) throw new Error("Management forms must render inside ManagementPanel.");
  return value;
}

/* ------------------------------------------------------------------ actions */

export interface FormError {
  message: string;
  fields: Record<string, string>;
  code?: string;
  status?: number;
}

export function toFormError(error: unknown, fallback?: string): FormError {
  return {
    message: errorMessage(error, fallback),
    fields: isApiError(error) && error.fields ? error.fields : {},
    code: isApiError(error) ? error.code : undefined,
    status: isApiError(error) ? error.status : undefined,
  };
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error?: FormError };

/**
 * One in-flight request at a time per form. A second submit while pending is
 * ignored rather than queued, so double clicks and Enter repeats never send a
 * duplicate mutation. Input state lives in the form, so failures keep it.
 */
export function useAction() {
  const panel = usePanel();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<ActionResult<T>> => {
    if (busy.current) return { ok: false };
    busy.current = true;
    panel.trackBusy(1);
    setPending(true);
    setError(null);
    try {
      const value = await work();
      return { ok: true, value };
    } catch (caught) {
      const formError = toFormError(caught);
      if (mounted.current) setError(formError);
      return { ok: false, error: formError };
    } finally {
      busy.current = false;
      panel.trackBusy(-1);
      if (mounted.current) setPending(false);
    }
  }, [panel]);

  return { pending, error, setError, run, clearError: useCallback(() => setError(null), []) };
}

/** Field error from the server's `fields` map or a local validation map. */
export function fieldError(error: FormError | null | undefined, ...names: string[]): string | undefined {
  if (!error) return undefined;
  for (const name of names) if (error.fields[name]) return error.fields[name];
  return undefined;
}

export function localError(fields: Record<string, string>): FormError | null {
  const keys = Object.keys(fields);
  if (!keys.length) return null;
  return { message: keys.length === 1 ? "Correct the highlighted field." : `Correct the ${keys.length} highlighted fields.`, fields };
}

/* ------------------------------------------------------------------ labels */

export const SORT_ORDER_LABELS = ["newest first", "oldest first"] as const;
/** Value 2 was “unfiltered”; it now means sanitized rich content. */
export const ITEM_ALLOWS_LABELS = ["text only", "text with images", "rich content (sanitized)"] as const;
export const EXPIRATION_WEEKS = [2, 4, 6, 10] as const;

export const HELP = {
  hotlinking: "Some sites block images that are shown on other sites, returning a 403 Forbidden error or a different image. Fever can load those images through your installation instead.",
  multiple: "Check each item you want. Use the filter to narrow a long list. You can also drag feeds onto groups and Sparks in the reader, or use a feed's menu.",
  "feed-auth": "Some feeds require a username and password. If a feed needs them and they are missing, Fever asks when it refreshes the feed. Saved credentials are never shown again.",
  "feed-title": "Optional. Leave blank to use the title the feed provides.",
  excerpts: "Some feeds link straight to the page the author is commenting on. If excerpted, you might miss their commentary.",
  sparks: "Sparks are inessential feeds that raise the temperature of links in Hot. Their unread items never appear in Kindling or your groups. Link blogs and sites that repost a lot are good Sparks.",
  "service-url": "Most services have an address for adding new items. Fever replaces %t with the title, %u with the address and %e with the excerpt, each encoded, before opening it. Put # before an http or https address to have Fever's server request it in the background instead; nothing is sent until you choose the service on an item.",
  "saved-feed": "When enabled, the saved items feed is listed on your Fever login page so feed readers can find it.",
  "item-expiration": "Fever deletes unsaved items older than this. A shorter period uses less database space, but older Hot time ranges have less to work with. Saved items are never expired.",
} as const;
export type HelpTopic = keyof typeof HELP;

/* ------------------------------------------------------------------ primitives */

type ButtonVariant = "plain" | "default" | "danger";

export function Button({ variant = "plain", pending, children, className, type = "button", disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; pending?: boolean }) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={`fm-btn fm-btn-${variant}${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}

export function HelpTip({ topic, label }: { topic: HelpTopic; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="fm-help">
      <button
        type="button"
        className="fm-help-toggle"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Help${label ? `: ${label}` : ""}`}
        onClick={() => setOpen((value) => !value)}
      >?</button>
      <span id={id} className="fm-help-text" role="note" hidden={!open}>{HELP[topic]}</span>
    </span>
  );
}

export function Row({ label, htmlFor, help, children, hint, error, errorId, labelAs = "label" }: {
  label?: ReactNode; htmlFor?: string; help?: HelpTopic; children: ReactNode; hint?: ReactNode;
  error?: string; errorId?: string; labelAs?: "label" | "span";
}) {
  return (
    <div className={`fm-row${error ? " fm-row-invalid" : ""}`}>
      <div className="fm-row-label">
        {label !== undefined && (labelAs === "label" && htmlFor
          ? <label htmlFor={htmlFor}>{label}</label>
          : <span>{label}</span>)}
        {help && <HelpTip topic={help} label={typeof label === "string" ? label : undefined} />}
      </div>
      <div className="fm-row-control">
        {children}
        {hint && <p className="fm-hint">{hint}</p>}
        {error && <p className="fm-field-error" id={errorId}>{error}</p>}
      </div>
    </div>
  );
}

export function TextField({ label, help, hint, error, id: givenId, className, ...input }:
  Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { id?: string; label: ReactNode; help?: HelpTopic; hint?: ReactNode; error?: string }) {
  const autoId = useId();
  const id = givenId ?? autoId;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : "", hint ? hintId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <Row label={label} htmlFor={id} help={help} error={error} errorId={errorId}
      hint={hint ? <span id={hintId}>{hint}</span> : undefined}>
      <input
        id={id}
        type="text"
        {...input}
        className={`fm-input${className ? ` ${className}` : ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
    </Row>
  );
}

export function Checkbox({ label, checked, onChange, disabled, hint, help, id: givenId, describedBy }: {
  label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
  hint?: ReactNode; help?: HelpTopic; id?: string; describedBy?: string;
}) {
  const autoId = useId();
  const id = givenId ?? autoId;
  return (
    <div className="fm-check">
      <input id={id} type="checkbox" checked={checked} disabled={disabled}
        aria-describedby={[hint ? `${id}-hint` : "", describedBy ?? ""].filter(Boolean).join(" ") || undefined}
        onChange={(event) => onChange(event.currentTarget.checked)} />
      <label htmlFor={id}>{label}</label>
      {help && <HelpTip topic={help} label={typeof label === "string" ? label : undefined} />}
      {hint && <p className="fm-hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

export function RadioGroup<T extends string | number>({ legend, value, options, onChange, name, help, disabled }: {
  legend: ReactNode; value: T; options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void; name?: string; help?: HelpTopic; disabled?: boolean;
}) {
  const autoName = useId();
  return (
    <fieldset className="fm-row fm-radio-row" disabled={disabled}>
      <legend className="fm-row-label">
        {legend}
        {help && <HelpTip topic={help} label={typeof legend === "string" ? legend : undefined} />}
      </legend>
      <div className="fm-row-control fm-radios">
        {options.map((option) => (
          <label key={String(option.value)} className="fm-radio">
            <input type="radio" name={name ?? autoName} checked={value === option.value}
              onChange={() => onChange(option.value)} />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ErrorBanner({ error }: { error: FormError | null | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  if (!error) return null;
  const fieldMessages = Object.entries(error.fields);
  return (
    <div ref={ref} className="fm-banner fm-banner-error" role="alert" tabIndex={-1}>
      <strong>{error.message}</strong>
      {fieldMessages.length > 0 && !fieldMessages.every(([, message]) => message === error.message) && (
        <ul>{fieldMessages.map(([field, message]) => <li key={field}>{message}</li>)}</ul>
      )}
    </div>
  );
}

export function StatusBanner({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "success" | "warning" }) {
  return <div className={`fm-banner fm-banner-${tone}`} role="status">{children}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="fm-loading" role="status" aria-live="polite"><span className="fm-spinner" aria-hidden="true" />{label}</p>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="fm-empty">{children}</p>;
}

/* ------------------------------------------------------------------ frame */

export interface TabSpec<T extends string = string> { id: T; label: string; invalid?: boolean; help?: HelpTopic; }

/**
 * The dialog form: dark title bar, optional tabs, white body and a right
 * aligned button row, after Fever's `#dialog form.tabbed` layout.
 */
export function Frame<T extends string>({ title, subtitle, tabs, activeTab, onTabChange, onSubmit, children, footer, size = "normal", busy }: {
  title: ReactNode; subtitle?: ReactNode; tabs?: readonly TabSpec<T>[]; activeTab?: T; onTabChange?: (tab: T) => void;
  onSubmit?: () => void; children: ReactNode; footer?: ReactNode; size?: "small" | "normal" | "wide"; busy?: boolean;
}) {
  const { titleId } = usePanel();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy) onSubmit?.();
  };
  return (
    <TabScope>
    <form className={`fm-frame fm-size-${size}${tabs ? " fm-tabbed" : ""}`} onSubmit={submit} noValidate aria-busy={busy || undefined}>
      <header className="fm-header">
        <h1 id={titleId}>{title}</h1>
        {tabs && activeTab !== undefined && onTabChange && (
          <TabList tabs={tabs} active={activeTab} onChange={onTabChange} />
        )}
      </header>
      <div className="fm-body">
        {subtitle && <h2 className="fm-subtitle">{subtitle}</h2>}
        {children}
      </div>
      {footer && <div className="fm-footer">{footer}</div>}
    </form>
    </TabScope>
  );
}

export function tabId(base: string, tab: string) { return `${base}-tab-${tab}`; }
export function panelId(base: string, tab: string) { return `${base}-panel-${tab}`; }

const TabBaseContext = createContext("fm");

function TabList<T extends string>({ tabs, active, onChange }: { tabs: readonly TabSpec<T>[]; active: T; onChange: (tab: T) => void }) {
  const base = useContext(TabBaseContext);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div className="fm-tabs" role="tablist" aria-label="Sections">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => { refs.current[tab.id] = node; }}
          type="button"
          role="tab"
          id={tabId(base, tab.id)}
          aria-controls={panelId(base, tab.id)}
          aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1}
          className={`fm-tab${tab.id === active ? " fm-tab-active" : ""}${tab.invalid ? " fm-tab-invalid" : ""}`}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") { event.preventDefault(); move(index + 1); }
            else if (event.key === "ArrowLeft") { event.preventDefault(); move(index - 1); }
            else if (event.key === "Home") { event.preventDefault(); move(0); }
            else if (event.key === "End") { event.preventDefault(); move(tabs.length - 1); }
          }}
        >
          {tab.label}
          {tab.invalid && <span className="fm-tab-flag" aria-label="(has errors)">!</span>}
        </button>
      ))}
    </div>
  );
}

/** Wrap a tabbed form so its tab and panel IDs are unique on the page. */
export function TabScope({ children }: { children: ReactNode }) {
  const base = useId().replace(/:/g, "");
  return <TabBaseContext.Provider value={base}>{children}</TabBaseContext.Provider>;
}

/** Inactive panels stay mounted (hidden) so their values survive tab switches. */
export function TabPanel({ tab, active, children }: { tab: string; active: boolean; children: ReactNode }) {
  const base = useContext(TabBaseContext);
  return (
    <div role="tabpanel" id={panelId(base, tab)} aria-labelledby={tabId(base, tab)} hidden={!active} className="fm-panel">
      {children}
    </div>
  );
}

export function Footer({ submitLabel, pending, pendingLabel, danger, disabled, cancelLabel = "Cancel", extra, onCancel }: {
  submitLabel?: string; pending?: boolean; pendingLabel?: string; danger?: boolean; disabled?: boolean;
  cancelLabel?: string; extra?: ReactNode; onCancel?: () => void;
}) {
  const { close } = usePanel();
  return (
    <>
      {extra && <div className="fm-footer-extra">{extra}</div>}
      <div className="fm-footer-buttons">
        <Button onClick={onCancel ?? close} disabled={pending}>{cancelLabel}</Button>
        {submitLabel && (
          <Button type="submit" variant={danger ? "danger" : "default"} pending={pending} disabled={disabled}>
            {pending ? pendingLabel ?? `${submitLabel}…` : submitLabel}
          </Button>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ multiselect */

export interface MultiOption { id: number; label: string; hint?: string; }

/**
 * Accessible replacement for Fever's `<select multiple>`: a labelled group of
 * checkboxes with a filter, select-all/none and a live selection count.
 */
export function MultiSelect({ legend, options, selected, onChange, help, emptyText, error, hint, filterThreshold = 8 }: {
  legend: ReactNode; options: readonly MultiOption[]; selected: readonly number[]; onChange: (ids: number[]) => void;
  help?: HelpTopic; emptyText?: ReactNode; error?: string; hint?: ReactNode; filterThreshold?: number;
}) {
  const [filter, setFilter] = useState("");
  const id = useId();
  const chosen = useMemo(() => new Set(selected), [selected]);
  const query = filter.trim().toLowerCase();
  const visible = query ? options.filter((option) => option.label.toLowerCase().includes(query)) : options;
  const toggle = (optionId: number, checked: boolean) => {
    const next = new Set(chosen);
    if (checked) next.add(optionId); else next.delete(optionId);
    onChange(options.filter((option) => next.has(option.id)).map((option) => option.id));
  };
  const setVisible = (checked: boolean) => {
    const next = new Set(chosen);
    for (const option of visible) { if (checked) next.add(option.id); else next.delete(option.id); }
    onChange(options.filter((option) => next.has(option.id)).map((option) => option.id));
  };
  return (
    <fieldset className={`fm-row fm-multi-row${error ? " fm-row-invalid" : ""}`} aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="fm-row-label">
        {legend}
        {help && <HelpTip topic={help} label={typeof legend === "string" ? legend : undefined} />}
      </legend>
      <div className="fm-row-control">
        {options.length === 0 ? (
          <EmptyState>{emptyText ?? "Nothing to choose from yet."}</EmptyState>
        ) : (
          <>
            <div className="fm-multi-tools">
              {options.length > filterThreshold && (
                <input
                  type="search"
                  className="fm-input fm-multi-filter"
                  placeholder="Filter"
                  aria-label="Filter the list"
                  value={filter}
                  onChange={(event) => setFilter(event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
                />
              )}
              <button type="button" className="fm-link" onClick={() => setVisible(true)}>select {query ? "shown" : "all"}</button>
              <button type="button" className="fm-link" onClick={() => setVisible(false)}>select none</button>
              <span className="fm-multi-count" aria-live="polite">{chosen.size} of {options.length} selected</span>
            </div>
            <ul className="fm-multi-list">
              {visible.map((option) => {
                const optionId = `${id}-${option.id}`;
                return (
                  <li key={option.id} className={chosen.has(option.id) ? "fm-multi-on" : undefined}>
                    <input id={optionId} type="checkbox" checked={chosen.has(option.id)}
                      onChange={(event) => toggle(option.id, event.currentTarget.checked)} />
                    <label htmlFor={optionId}>
                      {option.label}
                      {option.hint && <span className="fm-multi-hint"> {option.hint}</span>}
                    </label>
                  </li>
                );
              })}
              {visible.length === 0 && <li className="fm-multi-none">No matches for “{filter}”.</li>}
            </ul>
          </>
        )}
        {hint && <p className="fm-hint">{hint}</p>}
        {error && <p className="fm-field-error" id={`${id}-error`}>{error}</p>}
      </div>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ display overrides */

export type DisplayValues = Pick<DisplayOptions, "sortOrder" | "itemAllows" | "itemExcerpts" | "unreadCounts">;
export const INHERIT_ALL: DisplayValues = { sortOrder: -1, itemAllows: -1, itemExcerpts: -1, unreadCounts: -1 };

export function displayFrom(source?: Partial<DisplayOptions> | null): DisplayValues {
  const pick = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : -1);
  return {
    sortOrder: pick(source?.sortOrder), itemAllows: pick(source?.itemAllows),
    itemExcerpts: pick(source?.itemExcerpts), unreadCounts: pick(source?.unreadCounts),
  };
}

export function globalDisplay(preferences?: Preferences | null): DisplayValues {
  return {
    sortOrder: preferences?.sortOrder ?? 0, itemAllows: preferences?.itemAllows ?? 1,
    itemExcerpts: preferences?.itemExcerpts === false ? 0 : 1, unreadCounts: preferences?.unreadCounts ? 1 : 0,
  };
}

/**
 * The four display overrides shared by feeds and groups. Each row has an
 * explicit “inherit” checkbox (`-1`), as in Fever's display-options templates;
 * the control shows the inherited value until the user overrides it.
 */
export function DisplayOverrides({ value, onChange, inheritLabel, inherited, inheritedFrom, errors }: {
  value: DisplayValues; onChange: (value: DisplayValues) => void; inheritLabel: string;
  inherited: DisplayValues; inheritedFrom: string; errors?: FormError | null;
}) {
  const id = useId();
  const set = <K extends keyof DisplayValues>(key: K, next: number) => onChange({ ...value, [key]: next });
  const effective = (key: keyof DisplayValues) => (value[key] === -1 ? inherited[key] : value[key]);
  const inheritBox = (key: keyof DisplayValues, overrideValue: number) => (
    <label className="fm-inherit">
      <input type="checkbox" checked={value[key] === -1}
        onChange={(event) => set(key, event.currentTarget.checked ? -1 : overrideValue)} />
      {inheritLabel}
    </label>
  );
  return (
    <div className="fm-display">
      <p className="fm-hint">Settings marked “{inheritLabel}” follow {inheritedFrom}. Change a setting to override it.</p>
      <fieldset className="fm-row fm-radio-row">
        <legend className="fm-row-label">Item sort order</legend>
        <div className="fm-row-control fm-override">
          <div className="fm-radios">
            {SORT_ORDER_LABELS.map((label, index) => (
              <label key={label} className="fm-radio">
                <input type="radio" name={`${id}-sort`} checked={effective("sortOrder") === index}
                  onChange={() => set("sortOrder", index)} />
                {label}
              </label>
            ))}
          </div>
          {inheritBox("sortOrder", effective("sortOrder"))}
          {fieldError(errors, "sortOrder") && <p className="fm-field-error">{fieldError(errors, "sortOrder")}</p>}
        </div>
      </fieldset>
      <div className="fm-row">
        <div className="fm-row-label"><label htmlFor={`${id}-allows`}>Item content</label></div>
        <div className="fm-row-control fm-override">
          <select id={`${id}-allows`} className="fm-input fm-select" value={effective("itemAllows")}
            onChange={(event) => set("itemAllows", Number(event.currentTarget.value))}>
            {ITEM_ALLOWS_LABELS.map((label, index) => <option key={label} value={index}>{label}</option>)}
          </select>
          {inheritBox("itemAllows", effective("itemAllows"))}
          {fieldError(errors, "itemAllows") && <p className="fm-field-error">{fieldError(errors, "itemAllows")}</p>}
        </div>
      </div>
      <div className="fm-row">
        <div className="fm-row-label"><span>Excerpts</span><HelpTip topic="excerpts" label="Excerpts" /></div>
        <div className="fm-row-control fm-override">
          <label className="fm-check-inline">
            <input type="checkbox" checked={effective("itemExcerpts") > 0}
              onChange={(event) => set("itemExcerpts", event.currentTarget.checked ? 1 : 0)} />
            excerpt feed items
          </label>
          {inheritBox("itemExcerpts", effective("itemExcerpts"))}
        </div>
      </div>
      <div className="fm-row">
        <div className="fm-row-label"><span>Counts</span></div>
        <div className="fm-row-control fm-override">
          <label className="fm-check-inline">
            <input type="checkbox" checked={effective("unreadCounts") > 0}
              onChange={(event) => set("unreadCounts", event.currentTarget.checked ? 1 : 0)} />
            show unread counts
          </label>
          {inheritBox("unreadCounts", effective("unreadCounts"))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ misc */

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function feedTitle(feed: { title?: string; url?: string; siteUrl?: string }) {
  return feed.title?.trim() || feed.siteUrl || feed.url || "Untitled feed";
}

export function byTitle<T extends { title?: string; url?: string }>(a: T, b: T) {
  return feedTitle(a).localeCompare(feedTitle(b), undefined, { sensitivity: "base" });
}

/** Safe outbound href: only HTTP(S) addresses are rendered as links. */
export function safeHttpUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function numberResult(result: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = result?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

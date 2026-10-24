"use client";

import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode,
} from "react";
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

export type { ClientError as FormError } from "@/lib/client/errors";
import { describeError as toFormError, type ClientError as FormError } from "@/lib/client/errors";
export { toFormError };

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

export const EXPIRATION_WEEKS = [2, 4, 6, 10] as const;

export { HELP, HelpTip, type HelpTopic } from "../forms/HelpTip";
import { HelpTip, type HelpTopic } from "../forms/HelpTip";

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

/**
 * The dialog form: dark title bar, optional tabs, white body and a right
 * aligned button row, after Fever's `#dialog form.tabbed` layout.
 */
export function Frame<T extends string>({ title, subtitle, tabs, activeTab, onTabChange, onSubmit, children, footer, size = "normal", busy }: {
  title: ReactNode; subtitle?: ReactNode; tabs?: readonly TabSpec<T>[]; activeTab?: T; onTabChange?: (tab: T) => void;
  onSubmit?: () => void; children: ReactNode; footer?: ReactNode; size?: "small" | "normal" | "wide"; busy?: boolean;
}) {
  const { titleId, standalone } = usePanel();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy) onSubmit?.();
  };
  return (
    <TabScope>
    <form className={`fm-frame fm-size-${size}${tabs ? " fm-tabbed" : ""}`} onSubmit={submit} noValidate aria-busy={busy || undefined}>
      {(!standalone || tabs) && <header className="fm-header">
        {!standalone && <h1 id={titleId}>{title}</h1>}
        {tabs && activeTab !== undefined && onTabChange && (
          <TabList tabs={tabs} active={activeTab} onChange={onTabChange} />
        )}
      </header>}
      <div className="fm-body">
        {subtitle && <h2 className="fm-subtitle">{subtitle}</h2>}
        {children}
      </div>
      {footer && <div className="fm-footer">{footer}</div>}
    </form>
    </TabScope>
  );
}

export { TabList, TabScope, TabPanel, tabId, panelId, type TabSpec } from "../forms/Tabs";
import { TabList, TabScope, type TabSpec } from "../forms/Tabs";

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

export { DisplayOverrides, INHERIT_ALL, displayFrom, globalDisplay, SORT_ORDER_LABELS, ITEM_ALLOWS_LABELS, type DisplayValues } from "../forms/DisplayOverrides";

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

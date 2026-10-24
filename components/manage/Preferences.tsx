"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SESSION_EXPIRED_EVENT, appHref, command, getSession, resetSession } from "@/lib/client/api";
import { COMMANDS, CORE_LETTERS } from "@/lib/client/commands";
import type { Preferences, ReaderView, SharingService } from "@/lib/contracts";
import {
  Button, Checkbox, EXPIRATION_WEEKS, ErrorBanner, Footer, Frame, HelpTip, ITEM_ALLOWS_LABELS, RadioGroup, Row,
  SORT_ORDER_LABELS, StatusBanner, TabPanel, TextField, fieldError, localError, useAction, usePanel,
  type FormError, type TabSpec,
} from "./shared";
import type { PreferenceTab } from "./types";

/* ------------------------------------------------------------------ shortcuts */

/** The reader command a service key collides with, labeled from the reader's command table. */
function coreShortcut(key: string): string | undefined {
  if (!CORE_LETTERS.has(key)) return undefined;
  const upper = key.toUpperCase();
  return COMMANDS.find((entry) => entry.keys.some((keys) => keys.length === 1 && keys[0] === upper))?.label ?? "a core command";
}

/* ------------------------------------------------------------------ services */

interface ServiceRow { uid: number; id?: number; name: string; url: string; key: string; savedReason?: string; }

let serviceUid = 0;
const toRow = (service: SharingService): ServiceRow => ({
  uid: ++serviceUid, id: service.id, name: service.name ?? "", url: service.url ?? "", key: service.key ?? "",
  savedReason: service.enabled === false ? service.reason || "This service is disabled." : undefined,
});

/** A `#` template is a background service: Fever's server requests the address instead of opening a window. */
export function isBackgroundTemplate(url: string): boolean {
  return url.trim().startsWith("#");
}

/**
 * Why a template cannot run, mirroring the server's rules. Window templates
 * may use http, https or mailto; background (`#`) templates may use only http
 * or https. Neither may contain a username or password. Background requests
 * are sent only when the owner chooses the service on an item
 * (POST /api/share), never when preferences are saved.
 */
export function templateProblem(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const background = isBackgroundTemplate(trimmed);
  const target = background ? trimmed.slice(1).trim() : trimmed;
  if (/[\r\n]/.test(target)) return "The address cannot contain line breaks.";
  if (background && !target) return "Add the service address after the #.";
  if (background && target.startsWith("#")) return "Use a single # before the address.";
  let destination: URL;
  try {
    destination = new URL(target.replace(/\s+/g, "%20").replace(/%[tue]/g, "value"));
  } catch {
    return background
      ? "This address is not valid. After the #, start it with https:// or http://."
      : "This address is not valid. Start it with https://, http:// or mailto:.";
  }
  const scheme = destination.protocol.replace(/:$/, "");
  if (background && scheme === "mailto") return "Background (#) services can only request http or https addresses. Remove the # to open mailto addresses in your email program.";
  if (background && scheme !== "http" && scheme !== "https") return `Background (#) services can only request http or https addresses, not ${scheme}.`;
  if (!background && !["http", "https", "mailto"].includes(scheme)) return `${scheme} addresses are not allowed. Use http, https or mailto.`;
  if (destination.username || destination.password) return "Remove the username and password from the address.";
  return null;
}

function ServicesEditor({ rows, onChange, error }: { rows: ServiceRow[]; onChange: (rows: ServiceRow[]) => void; error: FormError | null }) {
  const id = useId();
  const urlRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const nameRefs = useRef<Record<number, HTMLInputElement | null>>({});
  // The row to focus once the parent commits the add or remove; read after every commit.
  const focusUid = useRef<number | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const uid = focusUid.current;
    if (uid === null) return;
    focusUid.current = null;
    nameRefs.current[uid]?.focus();
  });

  const update = (uid: number, patch: Partial<ServiceRow>) => onChange(rows.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
  const remove = (index: number) => {
    const row = rows[index];
    onChange(rows.filter((_, i) => i !== index));
    setAnnouncement(`${row.name || "Service"} removed. Save to apply.`);
    const next = rows[index + 1] ?? rows[index - 1];
    if (next) focusUid.current = next.uid;
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
    setAnnouncement(`${rows[index].name || "Service"} moved to position ${target + 1}.`);
  };
  const add = () => {
    const row: ServiceRow = { uid: ++serviceUid, name: "", url: "", key: "" };
    focusUid.current = row.uid;
    onChange([...rows, row]);
  };
  const insertToken = (uid: number, token: string) => {
    const input = urlRefs.current[uid];
    const row = rows.find((entry) => entry.uid === uid);
    if (!row) return;
    const start = input?.selectionStart ?? row.url.length;
    const end = input?.selectionEnd ?? row.url.length;
    update(uid, { url: row.url.slice(0, start) + token + row.url.slice(end) });
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const keyOwners = new Map<string, number>();
  rows.forEach((row) => {
    const key = row.key.trim().toLowerCase();
    if (key && row.url.trim() && !keyOwners.has(key)) keyOwners.set(key, row.uid);
  });

  return (
    <div className="fm-services">
      <div className="fm-services-head">
        <h3 id={`${id}-title`}>Sharing services <HelpTip topic="service-url" label="Service url" /></h3>
        <Button onClick={add}>Add service</Button>
      </div>
      <p className="fm-hint">
        Services appear in each item&apos;s menu in this order. Use %t for the title, %u for the address and %e for the excerpt.
        Start an http or https address with # to have Fever&apos;s server send it in the background instead of opening a window.
        Nothing is sent until you choose a service on an item. Rows without an address are removed when you save.
      </p>
      <p className="fm-visually-hidden" aria-live="polite">{announcement}</p>
      {rows.length === 0 ? (
        <p className="fm-empty">No sharing services. Add one to send items to email, a read-later service or a social site.</p>
      ) : (
        <ol className="fm-service-list" aria-labelledby={`${id}-title`}>
          {rows.map((row, index) => {
            const key = row.key.trim().toLowerCase();
            const problem = templateProblem(row.url);
            const keyInvalid = key !== "" && !/^[a-z0-9]$/.test(key);
            const duplicateOf = key && keyOwners.get(key) !== row.uid && row.url.trim() ? rows.find((other) => other.uid === keyOwners.get(key)) : undefined;
            const core = key ? coreShortcut(key) : undefined;
            const nameError = fieldError(error, `services.${index}.name`);
            const urlError = fieldError(error, `services.${index}.url`);
            const disabledReason = problem ?? urlError ?? (row.savedReason && row.url.trim() ? row.savedReason : null);
            const background = !disabledReason && isBackgroundTemplate(row.url);
            const label = row.name.trim() || `Service ${index + 1}`;
            return (
              <li key={row.uid} className={`fm-service${disabledReason ? " fm-service-disabled" : ""}`}>
                <div className="fm-service-fields">
                  <label className="fm-service-name">
                    <span>Name</span>
                    <input ref={(node) => { nameRefs.current[row.uid] = node; }} className="fm-input" value={row.name}
                      aria-invalid={nameError ? true : undefined}
                      onChange={(event) => update(row.uid, { name: event.currentTarget.value })} />
                  </label>
                  <label className="fm-service-url">
                    <span>Service url</span>
                    <input ref={(node) => { urlRefs.current[row.uid] = node; }} className="fm-input" value={row.url}
                      inputMode="url" spellCheck={false}
                      aria-invalid={problem || urlError ? true : undefined}
                      aria-describedby={disabledReason || background ? `${id}-${row.uid}-reason` : undefined}
                      onChange={(event) => update(row.uid, { url: event.currentTarget.value, savedReason: undefined })} />
                  </label>
                  <label className="fm-service-key">
                    <span>Key</span>
                    <input className="fm-input" value={row.key} maxLength={1} autoCapitalize="off" spellCheck={false}
                      aria-invalid={keyInvalid ? true : undefined}
                      aria-describedby={keyInvalid || duplicateOf || core ? `${id}-${row.uid}-key` : undefined}
                      onChange={(event) => update(row.uid, { key: event.currentTarget.value.slice(-1) })} />
                  </label>
                </div>
                <div className="fm-service-tools">
                  <span className="fm-token-buttons" role="group" aria-label={`Insert a token into ${label}'s address`}>
                    <button type="button" className="fm-token" onClick={() => insertToken(row.uid, "%t")}>%t title</button>
                    <button type="button" className="fm-token" onClick={() => insertToken(row.uid, "%u")}>%u url</button>
                    <button type="button" className="fm-token" onClick={() => insertToken(row.uid, "%e")}>%e excerpt</button>
                  </span>
                  <span className="fm-row-buttons">
                    <button type="button" className="fm-icon-btn" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                    <button type="button" className="fm-icon-btn" aria-label={`Move ${label} down`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>↓</button>
                    <button type="button" className="fm-link fm-danger-text" onClick={() => remove(index)}>Remove<span className="fm-visually-hidden"> {label}</span></button>
                  </span>
                </div>
                {disabledReason && (
                  <p className="fm-service-status" id={`${id}-${row.uid}-reason`}>
                    <span className="fm-tag fm-tag-off">{problem || urlError ? "invalid" : "disabled"}</span> {disabledReason}
                  </p>
                )}
                {background && (
                  <p className="fm-service-status" id={`${id}-${row.uid}-reason`}>
                    <span className="fm-tag">background</span> Choosing this service on an item makes Fever&apos;s server request
                    the address. No window opens, and nothing is sent before you choose it.
                  </p>
                )}
                {(keyInvalid || duplicateOf || core) && (
                  <p className="fm-service-status" id={`${id}-${row.uid}-key`}>
                    {keyInvalid && <>The key must be one letter or number. </>}
                    {!keyInvalid && duplicateOf && (
                      <>“{key.toUpperCase()}” already sends to {duplicateOf.name || "another service"}, so this shortcut stays off until one of them changes. </>
                    )}
                    {!keyInvalid && !duplicateOf && core && (
                      <>“{key.toUpperCase()}” is also the reader shortcut for “{core}”. With an item focused, this service takes priority; otherwise the reader command runs. </>
                    )}
                    <button type="button" className="fm-link" onClick={() => update(row.uid, { key: "" })}>Clear shortcut</button>
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ login */

const PASSWORD_MIN_CHARACTERS = 12;
const PASSWORD_MAX_BYTES = 1024;

/** The server's password policy: at least 12 Unicode characters and at most 1,024 UTF-8 bytes. */
export function passwordProblem(password: string): string | null {
  if (Array.from(password).length < PASSWORD_MIN_CHARACTERS) return `Use at least ${PASSWORD_MIN_CHARACTERS} characters.`;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return "This password is too long. Use at most 1,024 bytes (fewer characters if it includes accented letters, symbols or emoji).";
  return null;
}

function LoginSection() {
  const action = useAction();
  const [email, setEmail] = useState("");
  const [originalEmail, setOriginalEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [current, setCurrent] = useState("");
  const [loadingEmail, setLoadingEmail] = useState(true);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    let active = true;
    getSession()
      .then((session) => {
        if (!active) return;
        setEmail(session.owner?.email ?? "");
        setOriginalEmail(session.owner?.email ?? "");
      })
      .catch(() => undefined)
      .finally(() => { if (active) setLoadingEmail(false); });
    return () => { active = false; };
  }, []);

  const submit = async () => {
    const fields: Record<string, string> = {};
    const emailChanged = email.trim() !== originalEmail;
    if (!emailChanged && !password) fields.email = "Change the email or enter a new password.";
    if (emailChanged && !/^[^\s@]+@[^\s@]+$/.test(email.trim())) fields.email = "Enter a valid email address.";
    const weak = password ? passwordProblem(password) : null;
    if (weak) fields.password = weak;
    if (password && password !== confirm) fields.confirm = "The new passwords do not match.";
    if (!current) fields.currentPassword = "Enter your current password to confirm this change.";
    const invalid = localError(fields);
    if (invalid) { action.setError(invalid); return; }
    const payload: Record<string, unknown> = { currentPassword: current };
    if (emailChanged) payload.email = email.trim();
    if (password) payload.password = password;
    const result = await action.run(() => command("account.update", payload));
    if (!result.ok) return;
    setPassword("");
    setConfirm("");
    setCurrent("");
    // account.update answers reauthenticate:true after revoking every session,
    // including this browser's, so the cached session and CSRF token are stale.
    resetSession();
    setSignedOut(true);
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  };

  if (signedOut) {
    return (
      <div className="fm-login">
        <StatusBanner tone="success">
          Your login was changed. Every browser and device is now signed out, including this one. Fever API clients
          (feed reader apps) must also sign in again with the new email and password.
        </StatusBanner>
        <p className="fm-lead">
          Log in again before you change other preferences. <a href={appHref("/login")}>Log in with your new details</a>.
        </p>
      </div>
    );
  }

  // The login fields have their own button; Enter here must not save the other tabs.
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  };

  return (
    <div className="fm-login">
      <p className="fm-hint fm-panel-intro">
        Changing your email or password signs out every browser and device, including this one, and changes the key that
        Fever API clients (feed reader apps) use, so each client must sign in again. Your current password is required.
        Passwords are never shown.
      </p>
      <ErrorBanner error={action.error} />
      <TextField label="Email" type="email" value={email} autoComplete="username" disabled={loadingEmail}
        onChange={(event) => setEmail(event.currentTarget.value)} onKeyDown={onEnter} error={fieldError(action.error, "email")} />
      <TextField label="New password" type="password" value={password} autoComplete="new-password"
        hint="Leave blank to keep your password. A new password needs at least 12 characters and at most 1,024 bytes. Spaces are kept exactly as typed."
        onChange={(event) => setPassword(event.currentTarget.value)} onKeyDown={onEnter} error={fieldError(action.error, "password")} />
      <TextField label="Confirm new password" type="password" value={confirm} autoComplete="new-password" disabled={!password}
        onChange={(event) => setConfirm(event.currentTarget.value)} onKeyDown={onEnter} error={fieldError(action.error, "confirm")} />
      <TextField label="Current password" type="password" value={current} autoComplete="current-password"
        onChange={(event) => setCurrent(event.currentTarget.value)} onKeyDown={onEnter} error={fieldError(action.error, "currentPassword")} />
      <div className="fm-inline-submit">
        <Button variant="default" onClick={() => void submit()} pending={action.pending}>
          {action.pending ? "Changing login…" : "Change login"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ preferences */

type Draft = Pick<Preferences, (typeof FLAG_KEYS)[number]> & {
  refreshInterval: string; perPage: string; sessionTimeout: string;
};

const TAB_FIELDS: Record<Exclude<PreferenceTab, "login">, string[]> = {
  behavior: ["newWindow", "anonymize", "autoRead", "autoSpark", "autoUpdate", "toggleClick", "mobileReadOnScroll", "mobileReadOnBackOut", "mobileViewInApp", "sessionTimeout"],
  display: ["useCelsius", "layout", "sortOrder", "itemAllows", "itemExcerpts", "unreadCounts", "perPage"],
  refreshing: ["itemExpiration", "autoRefresh", "autoReload", "refreshInterval"],
  sharing: ["share", "shareProtected", "services"],
};

function tabForField(field: string): PreferenceTab {
  const root = field.split(".")[0];
  for (const [tab, fields] of Object.entries(TAB_FIELDS)) if (fields.includes(root)) return tab as PreferenceTab;
  return "behavior";
}

/** Flags sent by preferences.save. Blacklist rules are saved by blacklist.save. */
const FLAG_KEYS = [
  "useCelsius", "itemExpiration", "newWindow", "unreadCounts", "layout", "itemExcerpts", "itemAllows", "sortOrder",
  "autoSpark", "autoRead", "mobileReadOnScroll", "mobileReadOnBackOut", "mobileViewInApp", "autoReload", "autoRefresh",
  "autoUpdate", "toggleClick", "anonymize", "share", "shareProtected",
] as const;

function toDraft(preferences: Preferences): Draft {
  const flags = Object.fromEntries(FLAG_KEYS.map((key) => [key, preferences[key]])) as Pick<Preferences, (typeof FLAG_KEYS)[number]>;
  return {
    ...flags,
    // Publishing protected-feed content is opt-in; a missing value means no.
    shareProtected: preferences.shareProtected === true,
    refreshInterval: String(preferences.refreshInterval),
    perPage: String(preferences.perPage),
    sessionTimeout: String(preferences.sessionTimeout),
  };
}

/** Matches the schema, import and domain limit, so imported values of 101–200 save unchanged. */
const MAX_PER_PAGE = 200;

function boundedInteger(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

export function PreferencesForm({ view, initialTab = "behavior" }: { view: ReaderView; initialTab?: PreferenceTab }) {
  const panel = usePanel();
  const action = useAction();
  const [tab, setTab] = useState<PreferenceTab>(initialTab);
  const [draft, setDraft] = useState<Draft>(() => toDraft(view.preferences));
  const [services, setServices] = useState<ServiceRow[]>(() => (view.preferences.services ?? []).map(toRow));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const invalidTabs = useMemo((): Set<PreferenceTab> => {
    const tabs = new Set<PreferenceTab>();
    if (action.error) for (const field of Object.keys(action.error.fields)) tabs.add(tabForField(field));
    return tabs;
  }, [action.error]);

  const tabs: TabSpec<PreferenceTab>[] = [
    { id: "behavior", label: "Behavior", invalid: invalidTabs.has("behavior") },
    { id: "display", label: "Display", invalid: invalidTabs.has("display") },
    { id: "refreshing", label: "Refreshing", invalid: invalidTabs.has("refreshing") },
    { id: "sharing", label: "Sharing", invalid: invalidTabs.has("sharing") },
    { id: "login", label: "Login" },
  ];

  const submit = async () => {
    const fields: Record<string, string> = {};
    const refreshInterval = boundedInteger(draft.refreshInterval, 1, 1440);
    const perPage = boundedInteger(draft.perPage, 1, MAX_PER_PAGE);
    const sessionTimeout = boundedInteger(draft.sessionTimeout, 1, 1440);
    if (refreshInterval === null) fields.refreshInterval = "Enter a refresh interval from 1 to 1,440 minutes.";
    if (perPage === null) fields.perPage = `Enter from 1 to ${MAX_PER_PAGE} items per page.`;
    if (sessionTimeout === null) fields.sessionTimeout = "Enter from 1 to 1,440 minutes.";
    const kept = services.filter((row) => row.url.trim());
    kept.forEach((row) => {
      const index = services.indexOf(row);
      if (!row.name.trim()) fields[`services.${index}.name`] = `Name the service that opens ${row.url.trim().slice(0, 60)}.`;
      const key = row.key.trim().toLowerCase();
      if (key && !/^[a-z0-9]$/.test(key)) fields[`services.${index}.key`] = `${row.name.trim() || "A service"}: the key must be one letter or number.`;
    });
    const invalid = localError(fields);
    if (invalid) {
      action.setError(invalid);
      const first = Object.keys(fields)[0];
      setTab(tabForField(first));
      return;
    }
    const payload: Record<string, unknown> = {
      ...Object.fromEntries(FLAG_KEYS.map((key) => [key, draft[key]])),
      refreshInterval, perPage, sessionTimeout,
      services: kept.map((row) => ({
        ...(row.id === undefined ? {} : { id: row.id }),
        name: row.name.trim(),
        url: (isBackgroundTemplate(row.url) ? `#${row.url.trim().slice(1).trim()}` : row.url.trim()).replace(/\s+/g, "%20"),
        key: row.key.trim().toLowerCase(),
      })),
    };
    const result = await action.run(() => command("preferences.save", payload));
    if (!result.ok) {
      const first = result.error ? Object.keys(result.error.fields)[0] : undefined;
      if (first) setTab(tabForField(first));
      return;
    }
    await panel.changed();
    panel.close();
  };

  const savedRssHref = appHref("/rss/saved");
  const errors = action.error;

  return (
    <Frame title="Preferences" tabs={tabs} activeTab={tab} onTabChange={setTab} onSubmit={submit} busy={action.pending} size="wide"
      footer={(
        <Footer submitLabel="Save" pendingLabel="Saving…" pending={action.pending}
          extra={tab === "login" ? <span className="fm-muted">Save applies the other tabs. Use Change login for your email and password.</span> : undefined} />
      )}>
      {tab !== "login" && <ErrorBanner error={errors} />}

      <TabPanel tab="behavior" active={tab === "behavior"}>
        <fieldset className="fm-group">
          <legend>Reading</legend>
          <Checkbox label="open links in new window/tab" checked={draft.newWindow} onChange={(value) => set("newWindow", value)} />
          <Checkbox label="anonymize referrers from this Fever installation" checked={draft.anonymize} onChange={(value) => set("anonymize", value)}
            hint="Sites you open are not told which page linked to them." />
          <Checkbox label="mark items as read as they scroll past" checked={draft.autoRead} onChange={(value) => set("autoRead", value)} />
          <Checkbox label="toggle item excerpts on click" checked={draft.toggleClick} onChange={(value) => set("toggleClick", value)}
            hint="Clicking an item outside its links switches between the excerpt and full content." />
          <Checkbox label="add new feeds to Sparks" checked={draft.autoSpark} onChange={(value) => set("autoSpark", value)} help="sparks" />
          <TextField label="New items" type="number" inputMode="numeric" min={1} max={1440} className="fm-input-short"
            value={draft.sessionTimeout} onChange={(event) => set("sessionTimeout", event.currentTarget.value)}
            hint="Minutes away from Fever before your next visit starts a new reading session. Items that arrived since your last session are marked new."
            error={fieldError(errors, "sessionTimeout")} />
        </fieldset>
        <fieldset className="fm-group">
          <legend>Mobile</legend>
          <Checkbox label="mark items as read as they scroll past" checked={draft.mobileReadOnScroll} onChange={(value) => set("mobileReadOnScroll", value)} />
          <Checkbox label="mark items as read when going back to the feed list" checked={draft.mobileReadOnBackOut} onChange={(value) => set("mobileReadOnBackOut", value)}
            hint="Marks every unread item in the list you leave, including ones you scrolled past without opening." />
          <Checkbox label="open links inside Fever" checked={draft.mobileViewInApp} onChange={(value) => set("mobileViewInApp", value)}
            hint="Pages that refuse to be shown inside another site open in a new tab instead." />
        </fieldset>
        <fieldset className="fm-group">
          <legend>Updates</legend>
          <Checkbox label="automatically install updates" checked={draft.autoUpdate} onChange={(value) => set("autoUpdate", value)}
            hint="Kept from your previous installation. Fever no longer downloads updates itself; whoever runs this server installs new versions." />
        </fieldset>
      </TabPanel>

      <TabPanel tab="display" active={tab === "display"}>
        <RadioGroup legend="Degrees" value={draft.useCelsius ? 1 : 0} onChange={(value) => set("useCelsius", value === 1)}
          options={[{ value: 0, label: "fahrenheit" }, { value: 1, label: "celsius" }]} />
        <RadioGroup legend="Layout" value={draft.layout} onChange={(value) => set("layout", value)}
          options={[{ value: 0, label: "fixed" }, { value: 1, label: "fluid" }]} />
        <RadioGroup legend="Item sort order" value={draft.sortOrder} onChange={(value) => set("sortOrder", value)}
          options={SORT_ORDER_LABELS.map((label, value) => ({ value, label }))} />
        <Row label="Item content" htmlFor="fm-pref-item-allows" error={fieldError(errors, "itemAllows")}
          hint="Rich content keeps more of the original formatting. Scripts and other unsafe markup are always removed.">
          <select id="fm-pref-item-allows" className="fm-input fm-select" value={draft.itemAllows}
            onChange={(event) => set("itemAllows", Number(event.currentTarget.value))}>
            {ITEM_ALLOWS_LABELS.map((label, value) => <option key={label} value={value}>{label}</option>)}
          </select>
        </Row>
        <Row labelAs="span">
          <Checkbox label="excerpt items" checked={draft.itemExcerpts} onChange={(value) => set("itemExcerpts", value)} help="excerpts" />
          <Checkbox label="show unread counts" checked={draft.unreadCounts} onChange={(value) => set("unreadCounts", value)} />
        </Row>
        <TextField label="Items per page" type="number" inputMode="numeric" min={1} max={MAX_PER_PAGE} className="fm-input-short"
          value={draft.perPage} onChange={(event) => set("perPage", event.currentTarget.value)}
          hint="Also the number of links per page in Hot. Feed reader apps still receive at most 50 items per request."
          error={fieldError(errors, "perPage")} />
        <p className="fm-hint">Groups and feeds can override these settings from their own Display tab.</p>
      </TabPanel>

      <TabPanel tab="refreshing" active={tab === "refreshing"}>
        <Row label="Expiration" htmlFor="fm-pref-expiration" help="item-expiration" error={fieldError(errors, "itemExpiration")}>
          <span className="fm-inline-field">
            Delete unsaved items older than{" "}
            <select id="fm-pref-expiration" className="fm-input fm-select fm-select-inline" value={draft.itemExpiration}
              onChange={(event) => set("itemExpiration", Number(event.currentTarget.value))}>
              {EXPIRATION_WEEKS.map((weeks) => <option key={weeks} value={weeks}>{weeks} weeks</option>)}
            </select>
          </span>
        </Row>
        <TextField label="Refresh every" type="number" inputMode="numeric" min={1} max={1440} className="fm-input-short"
          value={draft.refreshInterval} onChange={(event) => set("refreshInterval", event.currentTarget.value)}
          hint="Minutes between refreshes of each feed."
          error={fieldError(errors, "refreshInterval")} />
        <RadioGroup legend="Auto-refresh" value={draft.autoRefresh ? 1 : 0} onChange={(value) => set("autoRefresh", value === 1)}
          options={[
            { value: 1, label: "while Fever is open in a browser (and on the server schedule)" },
            { value: 0, label: "on the server schedule only" },
          ]} />
        <Row labelAs="span">
          <Checkbox label="reload interface after browser refresh" checked={draft.autoReload} onChange={(value) => set("autoReload", value)}
            hint="New items appear without losing your place in the list." />
        </Row>
      </TabPanel>

      <TabPanel tab="sharing" active={tab === "sharing"}>
        <fieldset className="fm-group">
          <legend>Saved items feed</legend>
          <Checkbox
            label={<>publish a feed of the 30 most recent <a href={savedRssHref} target="_blank" rel="noopener noreferrer">Saved items</a></>}
            help="saved-feed"
            checked={draft.share}
            onChange={(value) => set("share", value)}
          />
          <p className="fm-hint fm-share-note">
            This feed is public: anyone who knows its address can read the titles, links and content of your 30 most recently
            saved items, without logging in. It is also listed on your login page. Turn it off to make the address return nothing.
          </p>
          <Checkbox
            label="include saved items from feeds that need a password"
            checked={draft.shareProtected}
            disabled={!draft.share}
            onChange={(value) => set("shareProtected", value)}
            hint={draft.shareProtected
              ? "Content from password-protected feeds will be published to anyone with the address. Only do this if those publishers allow it."
              : "Off: items from password-protected feeds are left out of the public feed."}
          />
        </fieldset>
        <ServicesEditor rows={services} onChange={setServices} error={errors} />
      </TabPanel>

      <TabPanel tab="login" active={tab === "login"}>
        <LoginSection />
      </TabPanel>
    </Frame>
  );
}

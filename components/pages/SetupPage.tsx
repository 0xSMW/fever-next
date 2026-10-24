"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import type { SessionDTO } from "@/lib/contracts";
import { apiGet, apiPost, appHref } from "@/lib/client/api";
import { describeError, type DescribedError } from "./api-errors";
import { GetStarted } from "./GetStarted";
import { PageShell } from "./PageShell";
import { PasswordFields, passwordErrors } from "./PasswordFields";
import { ErrorNotice, Loading, Notice } from "./Status";
import { useFeverSession } from "./useFeverSession";

type Check = { state: "pending" | "ok" | "fail"; detail: string };
interface Preflight { secure: Check; cookies: Check; server: Check }
interface FieldErrors { token?: string; email?: string; password?: string; confirm?: string; baseUrl?: string }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SERVER_READY: Check = { state: "ok", detail: "The server reached its database and no owner exists yet." };

function Mark({ state }: { state: Check["state"] }) {
  if (state === "ok") return <span className="fp-mark fp-status-ok" aria-label="Passed">✓</span>;
  if (state === "fail") return <span className="fp-mark fp-status-bad" aria-label="Failed">✗</span>;
  return <span className="fp-mark" aria-label="Checking">…</span>;
}

/**
 * First-run setup. The server keeps setup closed once an owner exists; this
 * page only reflects that state and never offers a web reset of an existing
 * installation.
 */
export function SetupPage({ welcome }: { welcome: boolean }) {
  const { state, reload } = useFeverSession();

  if (state.status === "loading") {
    return <PageShell title="Installation" subtitle="Checking this server"><Loading>Checking installation state…</Loading></PageShell>;
  }
  if (state.status === "error") {
    return (
      <PageShell title="Installation" subtitle="Fever is not responding">
        <ErrorNotice title="Setup cannot start" error={state.error} onRetry={reload}>
          <p>Fever needs a reachable database before it can be installed. Check the server logs and configuration, then try again.</p>
        </ErrorNotice>
      </PageShell>
    );
  }
  const { session } = state;
  if (session.configured && session.authenticated) {
    return (
      <PageShell title="Get started" subtitle={welcome ? "Fever is installed and you are logged in" : "Add feeds to Fever"} width="wide">
        <GetStarted />
      </PageShell>
    );
  }
  if (session.configured) {
    return (
      <PageShell title="Installation" subtitle="Fever is already installed">
        <p>This server already has a Fever owner, so setup is closed. Nothing here can replace or reset the existing installation.</p>
        <ul className="fp-list">
          <li>To use the existing installation, log in.</li>
          <li>If you lost the password, ask the operator for a one-time recovery token.</li>
          <li>
            To start over, the operator must export or back up the data, then use the documented maintenance or uninstall
            procedure. A fresh setup is only possible against an empty database.
          </li>
        </ul>
        <div className="fp-actions">
          <Link className="fp-btn" href="/recovery">Reset password</Link>
          <Link className="fp-btn fp-default" href="/login">Log in</Link>
        </div>
      </PageShell>
    );
  }
  return <SetupForm onInstalledElsewhere={reload} />;
}

/** Connection and cookie checks, read from the browser. */
function browserChecks(): Pick<Preflight, "secure" | "cookies"> {
  if (typeof window === "undefined") {
    return {
      secure: { state: "pending", detail: "Checking the connection…" },
      cookies: { state: "pending", detail: "Checking cookies…" },
    };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const secure = window.location.protocol === "https:" || local;
  return {
    secure: secure
      ? { state: "ok", detail: window.location.protocol === "https:" ? "Connected over HTTPS." : "Local development address." }
      : { state: "fail", detail: "This page was not loaded over HTTPS. Your password would be sent unencrypted. Configure TLS at the reverse proxy first." },
    cookies: navigator.cookieEnabled
      ? { state: "ok", detail: "Cookies are enabled for login sessions." }
      : { state: "fail", detail: "Cookies are disabled in this browser. Fever needs them to keep you logged in." },
  };
}

// SetupPage renders this form only after the session request answers in the
// browser, never during server rendering or hydration, so its initial state
// can read window directly.
function SetupForm({ onInstalledElsewhere }: { onInstalledElsewhere: () => void }) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [preflight, setPreflight] = useState<Preflight>(() => ({
    ...browserChecks(),
    // This form only renders after GET /api/session answered configured:false,
    // which already required the database and schema. /api/health is not used:
    // it reports production readiness and stays 503 until setup has finished.
    server: SERVER_READY,
  }));
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [useCelsius, setUseCelsius] = useState(false);
  const [baseUrl, setBaseUrl] = useState(() => (typeof window === "undefined" ? "" : `${window.location.origin}${appHref("/")}`.replace(/\/$/, "")));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<DescribedError | null>(null);
  const [phase, setPhase] = useState<"form" | "installing" | "signing-in" | "installed">("form");

  const recheck = useCallback(() => {
    setPreflight({ ...browserChecks(), server: { state: "pending", detail: "Checking the server and database…" } });
    apiGet<SessionDTO>("/api/session").then(
      (session) => {
        if (session.configured) {
          onInstalledElsewhere();
          return;
        }
        setPreflight((current) => ({ ...current, server: SERVER_READY }));
      },
      (error: unknown) => {
        const described = describeError(error, "The server could not reach its database.");
        setPreflight((current) => ({ ...current, server: { state: "fail", detail: described.message } }));
      },
    );
  }, [onInstalledElsewhere]);

  const blocked = Object.values(preflight).some((check) => check.state !== "ok");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== "form" || blocked) return;
    const next: FieldErrors = { ...passwordErrors(password, confirm) };
    if (!token.trim()) next.token = "Paste the setup token from the server configuration.";
    if (!email.trim()) next.email = "Enter the email address you will log in with.";
    else if (!EMAIL_PATTERN.test(email.trim())) next.email = "Enter a complete email address, like you@example.com.";
    if (baseUrl.trim()) {
      try {
        const parsed = new URL(baseUrl.trim());
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.search || parsed.hash || parsed.username) next.baseUrl = "Use an http(s) address with an optional path and nothing after it.";
      } catch {
        next.baseUrl = "Enter a complete address, like https://example.com/fever.";
      }
    }
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) {
      if (next.baseUrl) setAdvancedOpen(true);
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }

    setPhase("installing");
    try {
      await apiPost("/api/setup", {
        token: token.trim(),
        email: email.trim(),
        password,
        useCelsius,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim().replace(/\/$/, "") } : {}),
      });
    } catch (error) {
      const described = describeError(error, "Fever could not be installed.");
      setErrors({
        token: described.fields?.token, email: described.fields?.email,
        password: described.fields?.password, baseUrl: described.fields?.baseUrl,
      });
      if (described.fields?.baseUrl) setAdvancedOpen(true);
      setFormError(described);
      setPhase("form");
      // Another browser may have finished setup in the meantime.
      if (described.status === 409 || described.code === "ALREADY_CONFIGURED") onInstalledElsewhere();
      return;
    }

    // Setup succeeded on the server. Sign in with the new credentials.
    setPhase("signing-in");
    setToken("");
    try {
      const result = await signIn("credentials", { email: email.trim(), password, redirect: false, callbackUrl: appHref("/setup?welcome=1") });
      setPassword("");
      setConfirm("");
      if (result && result.ok && !result.error) {
        window.location.replace(appHref("/setup?welcome=1"));
        return;
      }
    } catch {
      // Fall through to the manual login link.
    }
    setPassword("");
    setConfirm("");
    setPhase("installed");
  }

  if (phase === "installed") {
    return (
      <PageShell title="Installation" subtitle="Fever is installed">
        <Notice tone="success" live>
          <p>Your account was created, but Fever could not log you in automatically. Log in with the email and password you just chose.</p>
        </Notice>
        <div className="fp-actions">
          <Link className="fp-btn fp-default" href="/login">Log in</Link>
        </div>
      </PageShell>
    );
  }

  const busy = phase !== "form";
  const checks: Array<[keyof Preflight, string]> = [["secure", "Secure connection"], ["cookies", "Browser cookies"], ["server", "Server and database"]];

  return (
    <PageShell title="Installation" subtitle="Create a login">
      <h3 id={`${id}-preflight`}>Before you begin</h3>
      <ul className="fp-checks" aria-labelledby={`${id}-preflight`} aria-live="polite">
        {checks.map(([key, label]) => (
          <li key={key}>
            <Mark state={preflight[key].state} />
            <span><strong>{label}.</strong> {preflight[key].detail}</span>
          </li>
        ))}
      </ul>
      {blocked && preflight.server.state !== "pending" ? (
        <p><button type="button" className="fp-btn" onClick={recheck}>Check again</button></p>
      ) : null}

      {formError ? (
        <ErrorNotice title="Installation failed" error={formError}>
          {formError.status === 403 || formError.code === "INVALID_TOKEN" ? (
            <p>The setup token is configured on the server as <code>FEVER_SETUP_TOKEN</code>. Ask the operator for it.</p>
          ) : null}
        </ErrorNotice>
      ) : null}
      {phase === "installing" ? <Loading>Creating your Fever installation…</Loading> : null}
      {phase === "signing-in" ? <Loading>Installed. Logging you in…</Loading> : null}

      <form ref={formRef} method="post" action="" onSubmit={submit} noValidate>
        <fieldset className="fp-rows" disabled={busy}>
          <legend className="fp-sr-only">Owner account</legend>
          <div className="fp-row">
            <label className="fp-label" htmlFor={`${id}-token`}>Setup token</label>
            <div className="fp-field">
              <input
                id={`${id}-token`} name="token" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false}
                value={token} onChange={(event) => setToken(event.target.value)}
                aria-invalid={errors.token ? true : undefined}
                aria-describedby={`${id}-token-hint${errors.token ? ` ${id}-token-error` : ""}`}
              />
              <span className="fp-hint" id={`${id}-token-hint`}>The one-time installation token set by whoever deployed this server. It proves you are allowed to claim this installation.</span>
              {errors.token ? <span className="fp-field-error" id={`${id}-token-error`}>{errors.token}</span> : null}
            </div>
          </div>
          <div className="fp-row">
            <label className="fp-label" htmlFor={`${id}-email`}>Email</label>
            <div className="fp-field">
              <input
                id={`${id}-email`} name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="off" spellCheck={false}
                value={email} onChange={(event) => setEmail(event.target.value)}
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={`${id}-email-hint${errors.email ? ` ${id}-email-error` : ""}`}
              />
              <span className="fp-hint" id={`${id}-email-hint`}>The address you will use to log in to this Fever installation.</span>
              {errors.email ? <span className="fp-field-error" id={`${id}-email-error`}>{errors.email}</span> : null}
            </div>
          </div>
          <PasswordFields
            password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm}
            passwordError={errors.password} confirmError={errors.confirm}
          />
          <div className="fp-row" role="radiogroup" aria-labelledby={`${id}-temperature`}>
            <span className="fp-label" id={`${id}-temperature`}>Temperature</span>
            <div className="fp-field">
              <label className="fp-choice">
                <input type="radio" name="use_celsius" value="0" checked={!useCelsius} onChange={() => setUseCelsius(false)} /> fahrenheit
              </label>
              <label className="fp-choice">
                <input type="radio" name="use_celsius" value="1" checked={useCelsius} onChange={() => setUseCelsius(true)} /> celsius
              </label>
              <span className="fp-hint">Fever gives recurring &ldquo;hot&rdquo; links a temperature. Pick the more familiar scale; you can change it later in Preferences.</span>
            </div>
          </div>
          <div className="fp-row fp-row-stack">
            <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
              <summary>Installation address</summary>
              <div className="fp-field" style={{ marginTop: "0.5rem" }}>
                <label htmlFor={`${id}-base`} className="fp-sr-only">Installation address</label>
                <input
                  id={`${id}-base`} name="baseUrl" type="url" inputMode="url" autoCapitalize="off" spellCheck={false}
                  value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}
                  aria-invalid={errors.baseUrl ? true : undefined}
                  aria-describedby={`${id}-base-hint${errors.baseUrl ? ` ${id}-base-error` : ""}`}
                />
                <span className="fp-hint" id={`${id}-base-hint`}>
                  The public address of this installation, detected from this page. Feed readers, the Feedlet, and saved-item links use it. It must match the server&rsquo;s configured address.
                </span>
                {errors.baseUrl ? <span className="fp-field-error" id={`${id}-base-error`}>{errors.baseUrl}</span> : null}
              </div>
            </details>
          </div>
        </fieldset>
        <div className="fp-actions">
          <button type="submit" className="fp-btn fp-default" disabled={busy || blocked} aria-busy={busy || undefined}>
            {phase === "installing" ? "Installing…" : phase === "signing-in" ? "Logging in…" : "Install"}
          </button>
        </div>
        {blocked && !busy ? <p className="fp-small fp-muted">Install is available once every check above passes.</p> : null}
      </form>
    </PageShell>
  );
}

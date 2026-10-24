"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { apiPost, appHref } from "@/lib/client/api";
import { useIsClient } from "@/lib/client/hydration";
import { describeError } from "./api-errors";
import { PageShell } from "./PageShell";
import { PasswordFields, passwordErrors } from "./PasswordFields";

interface FieldErrors { token?: string; password?: string; confirm?: string }

const TOKEN_FRAGMENT = /(?:^#|&)token=([^&]+)/;

/**
 * One-time password recovery. The operator issues a short-lived token on the
 * server; this page exchanges it for a new password. Fever never emails or
 * displays an existing password.
 */
export function RecoveryPage() {
  const id = useId();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // A token may arrive in the URL fragment (never sent to the server or in
  // Referer). The first browser render after hydration copies it into the
  // field; the effect then removes it from the address bar.
  const client = useIsClient();
  const [fragmentRead, setFragmentRead] = useState(false);
  if (client && !fragmentRead) {
    setFragmentRead(true);
    const match = TOKEN_FRAGMENT.exec(window.location.hash);
    if (match) {
      try { setToken(decodeURIComponent(match[1])); } catch { /* ignore a malformed fragment */ }
    }
  }
  useEffect(() => {
    if (fragmentRead && TOKEN_FRAGMENT.test(window.location.hash)) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [fragmentRead]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || done) return;
    const next: FieldErrors = { ...passwordErrors(password, confirm) };
    if (!token.trim()) next.token = "Paste the recovery token you were given.";
    setErrors(next);
    setFormError(null);
    if (next.token || next.password || next.confirm) {
      const first = formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']");
      (first ?? tokenRef.current)?.focus();
      return;
    }
    setPending(true);
    try {
      await apiPost("/api/recovery", { token: token.trim(), password });
      setPassword("");
      setConfirm("");
      setToken("");
      setDone(true);
    } catch (error) {
      const described = describeError(error, "The password could not be changed.");
      setErrors({ token: described.fields?.token, password: described.fields?.password });
      setFormError(described.status === 429
        ? "Too many attempts. Wait a few minutes before trying again."
        : described.message);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <PageShell title="All set" subtitle="Password changed">
        <div className="fp-notice fp-success" role="status">
          <p>Your new password is saved. Every existing session, including other browsers and devices, was signed out.</p>
          <p>Fever API clients that log in with your email and password may need the new password too.</p>
        </div>
        <div className="fp-actions">
          <a className="fp-btn fp-default" href={appHref("/login?reason=reset")}>Log in</a>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="Remind me" subtitle="Reset your password">
      <p>
        Fever does not store your password in a readable form, so it cannot send it to you. Instead, whoever runs this
        server can create a one-time recovery token with Fever&rsquo;s recovery command. Tokens expire quickly and work once.
      </p>
      {formError ? (
        <div className="fp-notice fp-error" role="alert"><p><strong>Reset failed.</strong> {formError}</p></div>
      ) : null}
      <form ref={formRef} method="post" action="" onSubmit={submit} noValidate>
        <div className="fp-rows">
          <div className="fp-row">
            <label className="fp-label" htmlFor={`${id}-token`}>Token</label>
            <div className="fp-field">
              <input
                ref={tokenRef}
                id={`${id}-token`}
                name="token"
                type="text"
                autoComplete="one-time-code"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                aria-invalid={errors.token ? true : undefined}
                aria-describedby={errors.token ? `${id}-token-error` : undefined}
                disabled={pending}
                autoFocus
              />
              {errors.token ? <span className="fp-field-error" id={`${id}-token-error`}>{errors.token}</span> : null}
            </div>
          </div>
          <PasswordFields
            label="New password"
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            passwordError={errors.password}
            confirmError={errors.confirm}
            disabled={pending}
          />
        </div>
        <div className="fp-actions">
          <Link className="fp-btn" href="/login">Nevermind</Link>
          <button type="submit" className="fp-btn fp-default" disabled={pending} aria-busy={pending || undefined}>
            {pending ? "Saving…" : "Change password"}
          </button>
        </div>
      </form>
    </PageShell>
  );
}

"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useId, useRef, useState, type FormEvent } from "react";
import { appHref } from "@/lib/client/api";
import { safeReturnPath } from "./return-path";

interface LoginFormProps {
  /** App-relative path to open after a successful login. */
  returnTo?: string;
  initialEmail?: string;
  /** Called instead of navigating, for inline login continuation. */
  onSignedIn?: () => void;
  submitLabel?: string;
}

interface FieldErrors { email?: string; password?: string }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Credentials login through NextAuth. Failures are always reported with one
 * generic message so the form never reveals whether an address exists.
 */
export function LoginForm({ returnTo = "/", initialEmail = "", onSignedIn, submitLabel = "Login" }: LoginFormProps) {
  const id = useId();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const target = safeReturnPath(returnTo);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!email.trim()) errors.email = "Enter the email address you use for Fever.";
    else if (!EMAIL_PATTERN.test(email.trim())) errors.email = "Enter a complete email address, like you@example.com.";
    if (!password) errors.password = "Enter your password.";
    return errors;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const errors = validate();
    setFieldErrors(errors);
    setFormError(null);
    if (errors.email) { emailRef.current?.focus(); return; }
    if (errors.password) { passwordRef.current?.focus(); return; }
    setPending(true);
    try {
      // Passwords are sent exactly as typed; only the address is trimmed.
      const result = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
        callbackUrl: appHref(target),
      });
      if (result && result.ok && !result.error) {
        setSignedIn(true);
        setPassword("");
        if (onSignedIn) onSignedIn();
        else window.location.assign(appHref(target));
        return;
      }
      setPassword("");
      setFormError(result?.status === 429
        ? "Too many login attempts. Wait a few minutes before trying again."
        : "That email and password combination was not accepted.");
      passwordRef.current?.focus();
    } catch {
      setFormError("Fever could not be reached. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const emailErrorId = `${id}-email-error`;
  const passwordErrorId = `${id}-password-error`;

  return (
    <form method="post" action="" onSubmit={submit} noValidate aria-describedby={formError ? `${id}-form-error` : undefined}>
      {formError ? (
        <div className="fp-notice fp-error" role="alert" id={`${id}-form-error`}>
          <p><strong>Login failed.</strong> {formError}</p>
        </div>
      ) : null}
      {signedIn ? (
        <div className="fp-notice fp-success" role="status"><p>Logged in. Opening Fever…</p></div>
      ) : null}
      <div className="fp-rows">
        <div className="fp-row">
          <label className="fp-label" htmlFor={`${id}-email`}>Email</label>
          <div className="fp-field">
            <input
              ref={emailRef}
              id={`${id}-email`}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={fieldErrors.email ? true : undefined}
              aria-describedby={fieldErrors.email ? emailErrorId : undefined}
              disabled={pending || signedIn}
              autoFocus={!initialEmail}
            />
            {fieldErrors.email ? <span className="fp-field-error" id={emailErrorId}>{fieldErrors.email}</span> : null}
          </div>
        </div>
        <div className="fp-row">
          <label className="fp-label" htmlFor={`${id}-password`}>Password</label>
          <div className="fp-field">
            <input
              ref={passwordRef}
              id={`${id}-password`}
              name="password"
              type="password"
              autoComplete="current-password"
              autoCapitalize="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={fieldErrors.password ? passwordErrorId : undefined}
              disabled={pending || signedIn}
              autoFocus={!!initialEmail}
            />
            {fieldErrors.password ? <span className="fp-field-error" id={passwordErrorId}>{fieldErrors.password}</span> : null}
          </div>
        </div>
      </div>
      <div className="fp-actions">
        <Link className="fp-btn" href="/recovery">Reset password</Link>
        <button type="submit" className="fp-btn fp-default" disabled={pending || signedIn} aria-busy={pending || undefined}>
          {pending ? "Logging in…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

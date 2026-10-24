"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import { appHref } from "@/lib/client/api";
import { LoginForm } from "./LoginForm";
import { PageShell } from "./PageShell";
import { safeReturnPath } from "./return-path";
import { ErrorNotice, Loading, Notice } from "./Status";
import { useFeverSession } from "./useFeverSession";

interface LoginPageProps {
  returnTo: string;
  reason?: "expired" | "signedout" | "reset" | null;
  /** "logout" comes from the legacy `?logout` link, redirected by the compat route. */
  action?: "logout" | null;
}

export function LoginPage({ returnTo, reason = null, action = null }: LoginPageProps) {
  const target = safeReturnPath(returnTo);
  const { state, reload } = useFeverSession();
  const alreadySignedIn = state.status === "ready" && state.session.configured && state.session.authenticated;
  const confirmLogout = action === "logout" && alreadySignedIn;
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    if (alreadySignedIn && action !== "logout") window.location.replace(appHref(target));
  }, [action, alreadySignedIn, target]);

  // A GET link only asks; the NextAuth sign-out POST runs on an explicit click,
  // so another site cannot log you out by linking here.
  async function logOut() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await signOut({ redirect: false });
      window.location.replace(appHref("/login?reason=signedout"));
    } catch {
      setLogoutError("Fever could not be reached. Check your connection and try again.");
      setLoggingOut(false);
    }
  }

  // Already logged out when the legacy link was followed: say so instead of a bare form.
  const shownReason = reason ?? (action === "logout" && state.status === "ready" && !alreadySignedIn ? "signedout" : null);

  return (
    <PageShell title={confirmLogout ? "Logout" : "Not so fast, hotshot"} subtitle={confirmLogout ? "Leave Fever on this browser" : "Login required"}>
      {shownReason === "expired" ? (
        <Notice tone="warning" live><p>Your session ended. Log in again to pick up where you left off.</p></Notice>
      ) : null}
      {shownReason === "signedout" ? (
        <Notice live><p>You have logged out of Fever.</p></Notice>
      ) : null}
      {shownReason === "reset" ? (
        <Notice tone="success" live><p>Your password was changed and every other session was signed out. Log in with the new password.</p></Notice>
      ) : null}

      {state.status === "loading" ? <Loading>Checking your session…</Loading> : null}
      {state.status === "error" ? (
        <ErrorNotice title="Fever is not responding" error={state.error} onRetry={reload} />
      ) : null}
      {state.status === "ready" && !state.session.configured ? (
        <div className="fp-notice fp-warning" role="status">
          <p><strong>Fever is not installed yet.</strong> There is no account to log in to.</p>
          <p><Link className="fp-btn fp-default" href="/setup">Set up Fever</Link></p>
        </div>
      ) : null}
      {confirmLogout ? (
        <>
          {logoutError ? <ErrorNotice title="Logout failed" error={logoutError} /> : null}
          <p>Log out of Fever in this browser? Other devices and feed reader apps stay logged in.</p>
          <div className="fp-actions">
            <a className="fp-btn" href={appHref(target)}>Cancel</a>
            <button type="button" className="fp-btn fp-default" onClick={logOut} disabled={loggingOut} aria-busy={loggingOut || undefined}>
              {loggingOut ? "Logging out…" : "Log out"}
            </button>
          </div>
        </>
      ) : null}
      {alreadySignedIn && !confirmLogout ? <Loading>You are already logged in. Opening Fever…</Loading> : null}
      {state.status === "ready" && state.session.configured && !state.session.authenticated ? (
        <>
          <LoginForm returnTo={target} />
          <p className="fp-small fp-muted">
            Forgot your password? Fever cannot email or display it. Ask whoever runs this server for a one-time
            recovery token, then <Link className="fp-link" href="/recovery">choose a new password</Link>.
          </p>
        </>
      ) : null}
    </PageShell>
  );
}

"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { SessionDTO } from "@/lib/contracts";
import { LoginForm } from "./LoginForm";
import { ErrorNotice, Loading } from "./Status";
import { useFeverSession } from "./useFeverSession";

interface SessionGateProps {
  /** App-relative path of the current page, used for login continuation. */
  returnTo: string;
  /** Short reason shown above the inline login form. */
  loginReason?: string;
  children: (session: SessionDTO & { owner: { id: number; email: string } }, reload: () => void) => ReactNode;
}

/**
 * Protected page content. The API still enforces authorization; this only
 * decides what to show: loading, a retryable error, setup, or an inline login
 * that reloads the page in place so the original URL and query survive.
 */
export function SessionGate({ returnTo, loginReason = "Log in to continue.", children }: SessionGateProps) {
  const { state, reload } = useFeverSession();

  if (state.status === "loading") return <Loading>Checking your session…</Loading>;
  if (state.status === "error") {
    return <ErrorNotice title="Fever is not responding" error={state.error} onRetry={reload} />;
  }
  const { session } = state;
  if (!session.configured) {
    return (
      <div className="fp-notice fp-warning" role="status">
        <p><strong>Fever is not installed yet.</strong> Finish setup before using this page.</p>
        <p><Link className="fp-btn fp-default" href="/setup">Set up Fever</Link></p>
      </div>
    );
  }
  if (!session.authenticated || !session.owner) {
    return (
      <>
        <p>{loginReason}</p>
        <LoginForm
          returnTo={returnTo}
          onSignedIn={() => {
            // A full reload picks up the new session cookie and CSRF binding
            // while keeping the original address and query string.
            window.location.reload();
          }}
        />
      </>
    );
  }
  return <>{children(session as SessionDTO & { owner: { id: number; email: string } }, reload)}</>;
}

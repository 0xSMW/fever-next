"use client";

import type { ReactNode } from "react";
import type { DescribedError } from "@/lib/client/errors";

export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <div className="fp-loading" role="status" aria-live="polite">
      <span className="fp-spinner" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

interface ErrorNoticeProps {
  error: DescribedError | string;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
  children?: ReactNode;
}

export function ErrorNotice({ error, title = "Something went wrong", onRetry, retryLabel = "Try again", children }: ErrorNoticeProps) {
  const message = typeof error === "string" ? error : error.message;
  return (
    <div className="fp-notice fp-error" role="alert">
      <p>
        <strong>{title}.</strong> {message}
      </p>
      {children}
      {onRetry ? (
        <p>
          <button type="button" className="fp-btn" onClick={onRetry}>{retryLabel}</button>
        </p>
      ) : null}
    </div>
  );
}

export function Notice({ tone = "info", children, live = false }: { tone?: "info" | "success" | "warning"; children: ReactNode; live?: boolean }) {
  const toneClass = tone === "info" ? "" : ` fp-${tone}`;
  return (
    <div className={`fp-notice${toneClass}`} role={live ? "status" : undefined} aria-live={live ? "polite" : undefined}>
      {children}
    </div>
  );
}

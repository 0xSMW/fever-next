"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { appHref } from "@/lib/client/api";
import { useIsClient } from "@/lib/client/hydration";
import { bookmarkletHref } from "./bookmarklet";

function absolute(path: string): string {
  return `${window.location.origin}${appHref(path)}`;
}

/**
 * A draggable bookmarklet link. React refuses javascript: hrefs, so the href
 * is assigned to the DOM node after mount. Activating it here explains what
 * to do instead of running it against Fever itself.
 */
export function FeedletBookmarklet({ variant = "full", label }: { variant?: "full" | "simple"; label?: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  // Disabled in the server and hydration renders, which have no href; the effect below sets it after the first commit.
  const ready = useIsClient();
  const [hint, setHint] = useState(false);

  useEffect(() => {
    ref.current?.setAttribute("href", bookmarkletHref(absolute("/feedlet"), variant));
  }, [variant]);

  const text = label ?? (variant === "full" ? "Feedlet" : "Feedlet (simple)");
  return (
    <span>
      <a
        ref={ref}
        className="fp-btn fp-default fp-bookmarklet"
        draggable
        aria-disabled={!ready || undefined}
        aria-describedby={hint ? `fp-feedlet-hint-${variant}` : undefined}
        onClick={(event) => {
          event.preventDefault();
          setHint(true);
        }}
      >
        {text}
      </a>
      {hint ? (
        <span id={`fp-feedlet-hint-${variant}`} role="status" className="fp-hint">
          Drag this button onto your bookmarks bar, or add a bookmark and paste its address from the copy field below.
        </span>
      ) : null}
    </span>
  );
}

/** Read-only copyable value with a copy button. */
export function CopyField({ label, value, description }: { label: string; value: string; description?: string }) {
  const id = useId();
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      inputRef.current?.select();
      setCopied("failed");
    }
  }
  return (
    <div className="fp-row fp-row-stack">
      <label className="fp-label" htmlFor={id}>{label}</label>
      <div className="fp-field">
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            ref={inputRef}
            id={id}
            type="text"
            readOnly
            value={value}
            onFocus={(event) => event.currentTarget.select()}
            spellCheck={false}
            style={{ fontFamily: "Monaco, Menlo, Consolas, monospace", fontSize: "0.85rem" }}
          />
          <button type="button" className="fp-btn" onClick={copy} disabled={!value}>copy</button>
        </div>
        {description ? <span className="fp-hint">{description}</span> : null}
        <span className="fp-hint" role="status" aria-live="polite">
          {copied === "copied" ? "Copied." : copied === "failed" ? "Copy was blocked. The text is selected; press Ctrl+C or ⌘C." : ""}
        </span>
      </div>
    </div>
  );
}

/** Values that need window.location: null on the server and during hydration. */
export function useInstallUrls(): { subscribe: string; feedletFull: string; feedletSimple: string; base: string } | null {
  const client = useIsClient();
  return useMemo(() => {
    if (!client) return null;
    const feedlet = absolute("/feedlet");
    return {
      base: absolute("/").replace(/\/$/, ""),
      subscribe: `${absolute("/subscribe")}?url=`,
      feedletFull: bookmarkletHref(feedlet, "full"),
      feedletSimple: bookmarkletHref(feedlet, "simple"),
    };
  }, [client]);
}

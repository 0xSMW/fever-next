"use client";
import { type MouseEvent, useEffect, useMemo, useRef } from "react";
import type { Preferences } from "@/lib/contracts";
import { safeUrl, sanitizeArticleHtml, splitHighlight } from "@/lib/client/safe-html";

/** Wrap matches of the search term in the source's highlight span. */
export function Highlight({ text, term }: { text: string; term?: string }) {
  if (!term) return <>{text}</>;
  return <>{splitHighlight(text, term).map((part, index) => part.match ? <span key={index} className="q">{part.text}</span> : part.text)}</>;
}

export interface ArticleContentProps {
  html: string;
  preferences: Pick<Preferences, "newWindow" | "anonymize">;
  highlight?: string;
  /** Intercept article link clicks (mobile view-in-app). Return true when handled. */
  onLinkClick?: (url: string) => boolean;
  className?: string;
}

/**
 * Article HTML inside the constrained .item-content container. The server
 * sends sanitized HTML; it is sanitized again here before insertion.
 */
export function ArticleContent({ html, preferences, highlight, onLinkClick, className = "item-content" }: ArticleContentProps) {
  const ref = useRef<HTMLDivElement>(null);
  const safe = useMemo(
    () => sanitizeArticleHtml(html, { highlight, newWindow: preferences.newWindow, anonymize: preferences.anonymize }),
    [html, highlight, preferences.newWindow, preferences.anonymize],
  );

  // Replace broken images with a visible, labelled placeholder.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const replace = (image: HTMLImageElement) => {
      if (!image.isConnected) return;
      const note = document.createElement("span");
      note.className = "broken-image";
      note.textContent = image.alt ? `Image unavailable: ${image.alt}` : "Image unavailable";
      image.replaceWith(note);
    };
    const images = Array.from(node.querySelectorAll("img"));
    const listeners = images.map((image) => {
      const onError = () => replace(image);
      if (image.complete && image.naturalWidth === 0 && image.getAttribute("src")) replace(image);
      else image.addEventListener("error", onError);
      return () => image.removeEventListener("error", onError);
    });
    return () => listeners.forEach((remove) => remove());
  }, [safe]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onLinkClick || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const anchor = (event.target as Element).closest("a[href]");
    if (!anchor || !ref.current?.contains(anchor)) return;
    const url = safeUrl(anchor.getAttribute("href") ?? "");
    if (url && /^https?:/i.test(url) && onLinkClick(url)) event.preventDefault();
  };

  if (!safe.trim()) return <div className={`${className} empty-content`}><p>This item has no content.</p></div>;
  return <div className={className} ref={ref} onClick={onClick} dangerouslySetInnerHTML={{ __html: safe }} />;
}

/** Plain-text excerpt (server excerpts are text, not HTML). */
export function ExcerptContent({ text, highlight, className = "item-content" }: { text: string; highlight?: string; className?: string }) {
  if (!text.trim()) return <div className={`${className} empty-content`}><p>This item has no excerpt. Open the full content to read it.</p></div>;
  return <div className={className}><p><Highlight text={text} term={highlight} /></p></div>;
}

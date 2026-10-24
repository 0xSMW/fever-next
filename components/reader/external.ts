import type { Preferences } from "@/lib/contracts";
import { safeUrl } from "@/lib/client/safe-html";

/** rel/target attributes for an external article link. */
export function externalLinkProps(url: string, preferences: Pick<Preferences, "newWindow" | "anonymize"> | undefined) {
  const href = safeUrl(url);
  if (!href || !/^(https?|mailto):/i.test(href)) return null;
  return {
    href,
    target: preferences?.newWindow ? "_blank" : undefined,
    rel: preferences?.anonymize ? "noopener noreferrer nofollow" : "noopener nofollow",
    referrerPolicy: preferences?.anonymize ? ("no-referrer" as const) : undefined,
  };
}

/**
 * Navigate to a validated external URL honoring new_window and anonymize.
 * A synthetic anchor keeps noopener/noreferrer semantics for both modes.
 * Returns false when the URL was rejected.
 */
export function openExternal(url: string, preferences: Pick<Preferences, "newWindow" | "anonymize"> | undefined): boolean {
  const props = externalLinkProps(url, preferences);
  if (!props) return false;
  const anchor = document.createElement("a");
  anchor.href = props.href;
  anchor.rel = props.rel;
  if (props.referrerPolicy) anchor.referrerPolicy = props.referrerPolicy;
  if (props.target) anchor.target = props.target;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}

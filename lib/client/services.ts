import type { SharingService } from "@/lib/contracts";
import { safeUrl } from "./safe-html";

export interface ShareSubject { title: string; url: string; excerpt: string; }

export interface PreparedService {
  service: SharingService;
  /** Destination URL, or null when the template is disabled. */
  href: string | null;
  /** "#"-prefixed templates are sent by the server (POST /api/share) on explicit request. */
  background: boolean;
  reason?: string;
}

/** Bird Feeder wrapper unwrapping from reader.js buildUrl(). */
function unwrapUrl(url: string): string {
  const match = /^.+\?FeederAction=[^&]+&feed=[^&]+&seed=([^&]+).*/.exec(url);
  if (!match) return url;
  try { return decodeURIComponent(match[1]); } catch { return url; }
}

export function shareExcerpt(text: string): string {
  let excerpt = text.replace(/\s+/g, " ").trim();
  if (excerpt.length > 200) excerpt = excerpt.slice(0, 200).replace(/\s\S+$/, "") + "…";
  return excerpt;
}

/**
 * Substitute %t, %u, %e with encoded values. javascript: and other non-web
 * templates are never executed; they are returned disabled with a reason.
 */
export function prepareService(service: SharingService, subject: ShareSubject): PreparedService {
  const template = service.url.trim();
  const background = template.startsWith("#");
  const body = background ? template.slice(1) : template;
  if (service.enabled === false) {
    return { service, href: null, background, reason: service.reason ?? "This service is disabled." };
  }
  if (/^\s*javascript:/i.test(body)) {
    return { service, href: null, background, reason: "Script services are not run by Fever. Edit this service in Preferences." };
  }
  const filled = body
    .replace(/%t/g, encodeURIComponent(subject.title))
    .replace(/%u/g, encodeURIComponent(unwrapUrl(subject.url)))
    .replace(/%e/g, encodeURIComponent(shareExcerpt(subject.excerpt)));
  const href = safeUrl(filled, "link");
  if (!href || href.startsWith("#")) {
    return { service, href: null, background, reason: service.reason ?? "Only HTTP, HTTPS, and mailto services are supported." };
  }
  if (background && !/^https?:/i.test(href)) {
    return { service, href: null, background, reason: "Background notifications must use an HTTP or HTTPS address." };
  }
  return { service, href, background };
}

/**
 * Defense-in-depth for article HTML. The server already sanitizes item HTML
 * with a versioned policy; this second pass runs in the browser with an
 * allowlist so a server regression still cannot execute script, load frames,
 * submit forms, or navigate through javascript: URLs inside the reader origin.
 * It also applies search highlighting to text nodes only.
 */
const ALLOWED_TAGS = new Set([
  "a", "abbr", "acronym", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br",
  "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl",
  "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "picture", "pre", "q", "rp", "rt", "ruby",
  "s", "samp", "section", "small", "source", "span", "strike", "strong", "sub", "summary", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul", "var", "wbr",
  "audio", "video", "track",
]);
/** Removed with their content rather than unwrapped. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input",
  "button", "select", "textarea", "option", "template", "noscript", "svg", "math", "link", "meta",
  "base", "title", "head", "canvas", "dialog", "portal",
]);
const GLOBAL_ATTRS = new Set(["title", "lang", "dir", "class"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "name"]),
  img: new Set(["src", "alt", "width", "height", "srcset", "sizes"]),
  source: new Set(["src", "srcset", "type", "media", "sizes"]),
  track: new Set(["src", "kind", "srclang", "label"]),
  audio: new Set(["src", "controls", "preload"]),
  video: new Set(["src", "controls", "preload", "poster", "width", "height"]),
  td: new Set(["colspan", "rowspan", "align", "valign"]),
  th: new Set(["colspan", "rowspan", "align", "valign", "scope"]),
  col: new Set(["span"]), colgroup: new Set(["span"]),
  ol: new Set(["start", "type", "reversed"]), li: new Set(["value"]),
  blockquote: new Set(["cite"]), q: new Set(["cite"]), del: new Set(["cite", "datetime"]),
  ins: new Set(["cite", "datetime"]), time: new Set(["datetime"]), details: new Set(["open"]),
  abbr: new Set(["title"]), table: new Set(["summary"]),
};
const URL_ATTRS = new Set(["href", "src", "poster", "cite"]);

export function safeUrl(value: string, kind: "link" | "media" = "link"): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed.startsWith("#")) return kind === "link" ? trimmed : null;
  try {
    const url = new URL(trimmed, typeof window === "undefined" ? "https://invalid.example/" : window.location.href);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    if (kind === "link" && url.protocol === "mailto:") return url.href;
    return null;
  } catch {
    return null;
  }
}

function safeSrcset(value: string): string | null {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const part of parts) {
    const [candidate, descriptor] = part.split(/\s+/, 2);
    const url = safeUrl(candidate, "media");
    if (url) kept.push(descriptor ? `${url} ${descriptor}` : url);
  }
  return kept.length ? kept.join(", ") : null;
}

export interface SanitizeOptions {
  /** Case-insensitive literal search term to wrap in <span class="q">. */
  highlight?: string;
  /** Open article links in a new window. */
  newWindow?: boolean;
  /** Send no referrer to article links (the anonymize preference). */
  anonymize?: boolean;
}

function cleanNode(node: Node, doc: Document, options: SanitizeOptions): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE || child.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) { element.remove(); continue; }
    if (!ALLOWED_TAGS.has(tag)) {
      cleanNode(element, doc, options);
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    const allowed = TAG_ATTRS[tag];
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (!GLOBAL_ATTRS.has(name) && !allowed?.has(name)) { element.removeAttribute(attr.name); continue; }
      if (URL_ATTRS.has(name)) {
        const url = safeUrl(attr.value, name === "href" || name === "cite" ? "link" : "media");
        if (url) element.setAttribute(name, url); else element.removeAttribute(attr.name);
      } else if (name === "srcset") {
        const set = safeSrcset(attr.value);
        if (set) element.setAttribute(name, set); else element.removeAttribute(attr.name);
      } else if (name === "class") {
        // Publisher classes must not borrow reader layout styles.
        element.removeAttribute(attr.name);
      }
    }
    if (tag === "a" && element.hasAttribute("href")) {
      const href = element.getAttribute("href") ?? "";
      if (!href.startsWith("#")) {
        element.setAttribute("rel", options.anonymize ? "noopener noreferrer nofollow" : "noopener nofollow");
        if (options.anonymize) element.setAttribute("referrerpolicy", "no-referrer");
        if (options.newWindow) element.setAttribute("target", "_blank");
      }
    }
    if (tag === "img") {
      element.setAttribute("loading", "lazy");
      element.setAttribute("decoding", "async");
      if (options.anonymize) element.setAttribute("referrerpolicy", "no-referrer");
    }
    if (tag === "video" || tag === "audio") {
      element.setAttribute("controls", "");
      element.setAttribute("preload", "none");
      element.removeAttribute("autoplay");
    }
    cleanNode(element, doc, options);
  }
}

function highlightText(root: Node, term: string, doc: Document): void {
  const needle = term.toLocaleLowerCase();
  if (!needle) return;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  for (const text of nodes) {
    const value = text.data;
    const lower = value.toLocaleLowerCase();
    if (lower.length !== value.length || !lower.includes(needle)) continue;
    const fragment = doc.createDocumentFragment();
    let index = 0;
    for (let found = lower.indexOf(needle); found !== -1; found = lower.indexOf(needle, index)) {
      if (found > index) fragment.append(value.slice(index, found));
      const mark = doc.createElement("span");
      mark.className = "q";
      mark.textContent = value.slice(found, found + needle.length);
      fragment.append(mark);
      index = found + needle.length;
    }
    if (index < value.length) fragment.append(value.slice(index));
    text.replaceWith(fragment);
  }
}

/** Returns sanitized HTML. Only call in the browser (DOMParser required). */
export function sanitizeArticleHtml(html: string, options: SanitizeOptions = {}): string {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  cleanNode(doc.body, doc, options);
  if (options.highlight) highlightText(doc.body, options.highlight, doc);
  return doc.body.innerHTML;
}

/** Plain text pieces with highlight markers, for React rendering of titles/excerpts. */
export function splitHighlight(value: string, term: string): Array<{ text: string; match: boolean }> {
  const needle = term.trim().toLocaleLowerCase();
  if (!needle) return [{ text: value, match: false }];
  const lower = value.toLocaleLowerCase();
  if (lower.length !== value.length) return [{ text: value, match: false }];
  const parts: Array<{ text: string; match: boolean }> = [];
  let index = 0;
  for (let found = lower.indexOf(needle); found !== -1; found = lower.indexOf(needle, index)) {
    if (found > index) parts.push({ text: value.slice(index, found), match: false });
    parts.push({ text: value.slice(found, found + needle.length), match: true });
    index = found + needle.length;
  }
  if (index < value.length) parts.push({ text: value.slice(index), match: false });
  return parts;
}

/** Text content of HTML, used for sharing excerpts. */
export function htmlToText(html: string): string {
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  doc.querySelectorAll("script,style,template").forEach((node) => node.remove());
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

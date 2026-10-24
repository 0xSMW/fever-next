import "server-only";
import { SaxesParser } from "saxes";
import type { FeedDTO, ImportResult } from "@/lib/contracts";
import type { OwnerContext } from "@/lib/auth";
import { assertOwner } from "@/lib/auth";
import { executeDomainCommand, getNavigation } from "@/lib/domain";
import { enqueueRefresh } from "@/lib/jobs";
import { HttpError, xmlText } from "./http";

interface Outline { title: string; url?: string; group?: string; isSpark: boolean; }
export interface OpmlPreview { title: string; feeds: Outline[]; groups: string[]; warnings: string[]; }
export function parseOpml(xml: string, importGroups: boolean): OpmlPreview {
  if (Buffer.byteLength(xml, "utf8") > 5_242_880) throw new HttpError("The OPML file exceeds 5 MiB.", 413, "OPML_TOO_LARGE");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new HttpError("OPML declarations and external entities are not supported.", 400, "UNSAFE_XML");
  const parser = new SaxesParser({ xmlns: false });
  const stack: { name: string; group?: string; isSpark: boolean }[] = [];
  const feeds: Outline[] = [], groupNames = new Set<string>(), warnings: string[] = [];
  let title = "", nodes = 0, root = "", inHeadTitle = false;
  parser.on("error", () => { throw new HttpError("The OPML file is not well-formed XML.", 400, "INVALID_XML"); });
  parser.on("doctype", () => { throw new HttpError("Document types are not allowed in OPML.", 400, "UNSAFE_XML"); });
  parser.on("opentag", tag => {
    if (++nodes > 30_000 || stack.length > 64) throw new HttpError("The OPML document has too many outlines or nested groups.");
    const name = tag.name.toLowerCase();
    if (!root) root = name;
    const parent = stack[stack.length - 1];
    let group = parent?.group, isSpark = parent?.isSpark ?? false;
    if (name === "outline") {
      const attrs = Object.fromEntries(Object.entries(tag.attributes).map(([key, value]) => [key.toLowerCase(), String(value)]));
      // Saxes has already decoded XML entities. Decoding again corrupts literal
      // entity text and can change an exported subscription URL on reimport.
      const label = (attrs.text ?? attrs.title ?? "").trim();
      if (label.length > 4096) throw new HttpError("An OPML title is too long.");
      if (attrs.xmlurl) {
        const url = attrs.xmlurl.trim();
        if (url.length > 8192) throw new HttpError("An OPML feed URL is too long.");
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new HttpError("An OPML outline contains an invalid feed URL."); }
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new HttpError("OPML feed URLs must use HTTP or HTTPS without embedded credentials.");
        feeds.push({ title: label, url, group, isSpark });
        if (feeds.length > 10_000) throw new HttpError("Import at most 10,000 feed outlines at a time.");
      } else if (label) {
        if (label === "Sparks") { isSpark = true; group = undefined; }
        else if (label === "All") { isSpark = false; group = undefined; }
        else { group = label; if (importGroups) groupNames.add(label); }
      }
    }
    inHeadTitle = name === "title" && parent?.name === "head";
    stack.push({ name, group, isSpark });
  });
  const titleText = (text: string) => { if (inHeadTitle) { title += text; if (title.length > 4096) throw new HttpError("The OPML title is too long."); } };
  parser.on("text", titleText);
  parser.on("cdata", titleText);
  parser.on("closetag", () => { stack.pop(); inHeadTitle = false; });
  try { parser.write(xml).close(); } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("The OPML file could not be read.", 400, "INVALID_XML");
  }
  if (root !== "opml") throw new HttpError("Choose an OPML document.");
  if (!feeds.length) throw new HttpError("The OPML document contains no feeds.");
  title = title.trim();
  if (!importGroups) {
    const group = title ? `${title} (imported)` : undefined;
    for (const feed of feeds) feed.group = group;
    if (group) groupNames.add(group);
  }
  if (feeds.some(feed => feed.isSpark)) warnings.push("Sparks remain Sparks; their stored group memberships are hidden in the reader.");
  return { title, feeds, groups: [...groupNames], warnings };
}

export async function importOpml(owner: OwnerContext, xml: string, importGroups: boolean): Promise<ImportResult> {
  await assertOwner(owner);
  const preview = parseOpml(xml, importGroups);
  const result: ImportResult = { feedsAdded: 0, groupsAdded: 0, membershipsAdded: 0, skipped: 0, warnings: [...preview.warnings] };
  const view = await getNavigation(owner);
  const groups = new Map(view.groups.map(group => [group.title, group.id]));
  const memberships = new Set(view.feeds.flatMap(feed => feed.groupIds.map(group => `${feed.id}:${group}`)));
  for (const title of preview.groups) {
    if (groups.has(title)) continue;
    const created = await executeDomainCommand(owner, "group.create", { title });
    groups.set(title, Number(created.id));
    if (created.created) result.groupsAdded++;
  }
  const refreshIds = new Set<number>();
  for (const [index, feed] of preview.feeds.entries()) {
    try {
      const groupId = feed.group ? groups.get(feed.group) : undefined;
      const created = await executeDomainCommand(owner, "feed.create", { url: feed.url, title: feed.title, isSpark: feed.isSpark, groupIds: groupId ? [groupId] : [] });
      const feedId = Number(created.id);
      if (!Number.isSafeInteger(feedId) || feedId <= 0) throw new Error("Missing subscription identity.");
      if (created.created) result.feedsAdded++;
      // Existing subscriptions keep their details, but each imported membership is additive.
      if (groupId && !memberships.has(`${feedId}:${groupId}`)) {
        await executeDomainCommand(owner, "membership.add", { feedId, groupId });
        memberships.add(`${feedId}:${groupId}`);
        result.membershipsAdded++;
      }
      if (feed.isSpark && !created.created) await executeDomainCommand(owner, "feed.update", { id: feedId, url: feed.url, isSpark: true });
      if (!created.created) result.skipped++;
      refreshIds.add(feedId);
    } catch (error) {
      result.skipped++;
      const message = error instanceof Error && "status" in error && typeof error.status === "number" && error.status < 500 ? error.message : "The subscription could not be imported; retrying this file is safe.";
      result.warnings.push(`Outline ${index + 1}: ${message}`);
    }
  }
  for (const id of refreshIds) {
    try { await enqueueRefresh(owner, { scope: "feed", id }); }
    catch { result.warnings.push("A subscription was imported, but its refresh could not be queued. Refresh it from the reader."); }
  }
  return result;
}

export async function exportOpml(owner: OwnerContext, options: { groupIds: number[]; flatten: boolean; includeSparks: boolean }) {
  await assertOwner(owner);
  const view = await getNavigation(owner);
  const all = { id: 0, title: "All", feedIds: view.feeds.filter(feed => !feed.isSpark).map(feed => feed.id) };
  const groups = new Map([all, ...view.groups.filter(group => group.id > 0)].map(group => [group.id, group]));
  const ids = options.groupIds.length ? options.groupIds : [...groups.keys()];
  if (ids.some(id => !groups.has(id))) throw new HttpError("An export group no longer exists.", 404, "GROUP_NOT_FOUND");
  const single = ids.length === 1 && ids[0] !== 0;
  const flatten = options.flatten || single;
  const groupTitle = single ? groups.get(ids[0])!.title : "";
  const title = `Fever${groupTitle ? ` // ${groupTitle}` : ""}`;
  const filename = `fever${groupTitle ? `-${groupTitle.normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "group"}` : ""}.opml`;
  const output = new Set<number>();
  const outline = (feed: FeedDTO) => `    <outline type="rss" text="${xmlText(feed.title)}" title="${xmlText(feed.title)}" xmlUrl="${xmlText(feed.url)}" htmlUrl="${xmlText(feed.siteUrl)}"/>`;
  const body: string[] = [];
  for (const id of ids) {
    const group = groups.get(id)!;
    const wanted = new Set(group.feedIds);
    const rows = view.feeds.filter(feed => !feed.isSpark && wanted.has(feed.id) && (!flatten || !output.has(feed.id)));
    rows.forEach(feed => output.add(feed.id));
    if (!flatten) body.push(`  <outline text="${xmlText(group.title)}">`);
    body.push(...rows.map(outline));
    if (!flatten) body.push("  </outline>");
  }
  if (options.includeSparks) {
    const sparks = view.feeds.filter(feed => feed.isSpark);
    if (sparks.length) {
      if (!flatten) body.push('  <outline text="Sparks">');
      body.push(...sparks.map(outline));
      if (!flatten) body.push("  </outline>");
    }
  }
  return { filename, xml: `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n<head><title>${xmlText(title)}</title></head>\n<body>\n${body.join("\n")}\n</body>\n</opml>\n` };
}

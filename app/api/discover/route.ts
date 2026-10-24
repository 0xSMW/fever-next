import { requireMutation } from "@/lib/auth";
import { discoverFeeds } from "@/lib/ingest";
import { getNavigation } from "@/lib/domain";
import { normalizeUrl } from "@/lib/legacy-url";
import { endpoint, HttpError, json, readJson } from "@/lib/integrations/http";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => endpoint(async () => {
  const owner = await requireMutation(request);
  const body = await readJson(request, 32_768);
  if (typeof body.url !== "string" || body.url.length > 8192) throw new HttpError("Enter a valid website or feed URL.");
  const candidates = await discoverFeeds(body.url);
  const view = await getNavigation(owner);
  const existing = new Set(view.feeds.map(feed => normalizeUrl(feed.url)));
  return json({ candidates: candidates.map(candidate => ({ ...candidate, subscribed: existing.has(normalizeUrl(candidate.url)) })) });
});

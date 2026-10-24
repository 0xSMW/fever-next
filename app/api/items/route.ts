import { requireOwner } from "@/lib/auth";
import { getNavigation, getReaderView } from "@/lib/domain";
import { endpoint, HttpError, integer, json } from "@/lib/integrations/http";
import { readerQuery } from "@/lib/integrations/reader-query";
export const dynamic = "force-dynamic";
/** Protected adapter retained for the prototype's item-list callers. */
export const GET = (request: Request) => endpoint(async () => {
  const query = readerQuery(new URL(request.url).searchParams);
  const owner = await requireOwner(), feedId = integer(query.feedId, "feedId", 1);
  const feed = (await getNavigation(owner)).feeds.find(feed => feed.id === feedId);
  if (!feed) throw new HttpError("This feed no longer exists.", 404, "FEED_NOT_FOUND");
  const view = await getReaderView(owner, { ...query, section: feed.isSpark ? "sparks" : "kindling", groupId: 0, feedId, showFeeds: true, showRead: true }, { capture: false });
  return json(view.items);
});

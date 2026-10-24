import { requireOwner } from "@/lib/auth";
import { getReaderView } from "@/lib/domain";
import { endpoint, integer, json } from "@/lib/integrations/http";
import { getFeedIdentity } from "@/lib/domain/catalog";
import { readerQuery } from "@/lib/integrations/reader-query";
export const dynamic = "force-dynamic";
/** Protected adapter retained for the prototype's item-list callers. */
export const GET = (request: Request) => endpoint(async () => {
  const query = readerQuery(new URL(request.url).searchParams);
  const owner = await requireOwner(), feedId = integer(query.feedId, "feedId", 1);
  const feed = await getFeedIdentity(owner, feedId);
  const view = await getReaderView(owner, { ...query, section: feed.isSpark ? "sparks" : "kindling", groupId: 0, feedId, showFeeds: true, showRead: true }, { capture: false });
  return json(view.items);
});

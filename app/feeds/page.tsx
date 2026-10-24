import { redirect } from "next/navigation";

/** The starter feed list is replaced by the reader's Kindling feeds pane. */
export default function FeedListPage() {
  // Next.js adds basePath when handling a server-component redirect.
  redirect("/?section=kindling&showFeeds=1");
}

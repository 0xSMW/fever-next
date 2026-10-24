import type { Metadata } from "next";
import { parseFeedletParams } from "@/components/pages/feedlet-candidates";
import { FeedletPage } from "@/components/pages/FeedletPage";
import { safeReturnPath } from "@/components/pages/return-path";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Feedlet · Fever°",
  robots: { index: false, follow: false },
  // The Feedlet URL carries the address of the page being read.
  referrer: "no-referrer",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function currentPath(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
    else if (value !== undefined) query.append(key, value);
  }
  const text = query.toString();
  return safeReturnPath(text ? `/feedlet?${text}` : "/feedlet");
}

/**
 * GET only displays candidates. Subscribing is a separate authenticated,
 * CSRF-protected POST made when the user confirms.
 */
export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const request = parseFeedletParams(params);
  return (
    <FeedletPage
      mode="feedlet"
      returnTo={currentPath(params)}
      initialUrl={request.pageUrl}
      pageTitle={request.pageTitle}
      supplied={request.supplied}
      rejected={request.rejected}
    />
  );
}

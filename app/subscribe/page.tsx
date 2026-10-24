import type { Metadata } from "next";
import { FeedletPage } from "@/components/pages/FeedletPage";
import { firstParam, safeExternalUrl, safeReturnPath } from "@/components/pages/return-path";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Subscribe · Fever°",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Subscription URL (source ?subscribe&url=). The source subscribed on GET;
 * this page only prefills a confirmation and subscribes on an explicit POST.
 */
export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const raw = firstParam(params.url)?.trim();
  // Apps sometimes pass "example.com/feed" without a scheme.
  const initialUrl = raw ? safeExternalUrl(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `http://${raw}`) : null;
  const returnTo = safeReturnPath(raw ? `/subscribe?url=${encodeURIComponent(raw)}` : "/subscribe");
  return <FeedletPage mode="subscribe" returnTo={returnTo} initialUrl={initialUrl} />;
}

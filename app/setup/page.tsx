import type { Metadata } from "next";
import { firstParam } from "@/components/pages/return-path";
import { SetupPage } from "@/components/pages/SetupPage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Installation · Fever°",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  return <SetupPage welcome={firstParam(params.welcome) === "1"} />;
}

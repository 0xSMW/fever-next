import type { Metadata } from "next";
import { ExtrasPage } from "@/components/pages/ExtrasPage";
import { firstParam } from "@/components/pages/return-path";

export const metadata: Metadata = {
  title: "Extras · Fever°",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  // Legacy ?refresh arrives as /extras?section=refresh (lib/compat/root.ts).
  const section = firstParam((await searchParams).section) === "refresh" ? "refresh" : null;
  return <ExtrasPage section={section} />;
}

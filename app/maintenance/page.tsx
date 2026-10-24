import type { Metadata } from "next";
import { MaintenancePage, type MaintenanceTarget } from "@/components/pages/MaintenancePage";
import { firstParam } from "@/components/pages/return-path";

export const metadata: Metadata = {
  title: "Maintenance · Fever°",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Legacy ?empty-cache arrives as ?operation=favicons; ?flush and the others keep their names (lib/compat/root.ts).
const operations = new Set<MaintenanceTarget>(["flush", "unorphan", "empty", "uninstall", "favicons"]);

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const requested = firstParam((await searchParams).operation);
  const operation = requested && operations.has(requested as MaintenanceTarget) ? (requested as MaintenanceTarget) : null;
  return <MaintenancePage operation={operation} />;
}

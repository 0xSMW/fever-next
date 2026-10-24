import type { Metadata } from "next";
import { DiagnosticsPage } from "@/components/pages/DiagnosticsPage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Diagnostics · Fever°",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <DiagnosticsPage />;
}

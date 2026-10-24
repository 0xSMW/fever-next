import type { Metadata } from "next";
import { BlacklistPage } from "@/components/pages/BlacklistPage";

export const metadata: Metadata = {
  title: "Blacklist · Fever°",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <BlacklistPage />;
}

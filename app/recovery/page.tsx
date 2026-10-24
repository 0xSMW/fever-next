import type { Metadata } from "next";
import { RecoveryPage } from "@/components/pages/RecoveryPage";

export const metadata: Metadata = {
  title: "Reset password · Fever°",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function Page() {
  return <RecoveryPage />;
}

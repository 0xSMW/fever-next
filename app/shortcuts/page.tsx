import type { Metadata } from "next";
import { ShortcutsPage } from "@/components/pages/ShortcutsPage";

export const metadata: Metadata = {
  title: "Keyboard Shortcuts · Fever°",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <ShortcutsPage />;
}

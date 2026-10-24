import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getOwner } from "@/lib/auth";
import { getReleaseInfo } from "@/components/pages/release.server";
import { loginPath } from "@/components/pages/return-path";
import { UpdatedPage } from "@/components/pages/UpdatedPage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Updated · Fever°",
  robots: { index: false, follow: false },
};

export default async function Page() {
  const owner = await getOwner();
  if (!owner) redirect(loginPath("/updated"));
  return <UpdatedPage release={await getReleaseInfo()} />;
}

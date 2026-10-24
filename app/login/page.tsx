import type { Metadata } from "next";
import { LoginPage } from "@/components/pages/LoginPage";
import { firstParam, safeReturnPath } from "@/components/pages/return-path";
import { savedRssMetadata } from "@/components/pages/saved-rss.server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Login · Fever°",
    robots: { index: false, follow: false },
    alternates: await savedRssMetadata(),
  };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const reasons = new Set(["expired", "signedout", "reset"]);

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  // Accept the modern ?return= and NextAuth's ?callbackUrl= (app-relative only).
  const requested = firstParam(params.return) ?? firstParam(params.callbackUrl);
  const reason = firstParam(params.reason);
  // Legacy ?logout arrives as /login?action=logout (lib/compat/root.ts).
  const action = firstParam(params.action) === "logout" ? "logout" : null;
  return (
    <LoginPage
      returnTo={safeReturnPath(requested)}
      reason={reason && reasons.has(reason) ? (reason as "expired" | "signedout" | "reset") : null}
      action={action}
    />
  );
}

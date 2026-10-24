"use client";
import { appHref } from "@/lib/client/api";
import { ManagementPanel } from "../manage/ManagementDialog";
import { PageShell } from "./PageShell";
import { SessionGate } from "./SessionGate";

export function BlacklistPage() {
  return <PageShell title="Blacklist" width="wide" nav>
    <SessionGate returnTo="/blacklist">{() => <ManagementPanel request={{ kind: "blacklist" }} standalone onClose={() => { window.location.href = appHref("/"); }} onChanged={async () => {}} />}</SessionGate>
  </PageShell>;
}

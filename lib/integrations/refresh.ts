import "server-only";
import type { RefreshAfterChangeResult } from "../command-contract";
import type { OwnerContext } from "@/lib/auth";
import { enqueueRefresh, type RefreshScope } from "@/lib/jobs";
import { logEvent } from "@/lib/observability/log";

/** The primary change has committed. A queue failure must not imply it was rolled back. */
export async function refreshAfterChange(owner: OwnerContext, scope: RefreshScope): Promise<RefreshAfterChangeResult> {
  try { return { job: await enqueueRefresh(owner, scope), warnings: [] as string[] }; }
  catch {
    logEvent("refresh.enqueue_after_change_failed", { scope: scope.scope, id: scope.id ?? null });
    return { job: null, warnings: ["The change was saved, but its refresh could not be queued. Start a refresh from the reader."] };
  }
}

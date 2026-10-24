import type { ViewState } from "../contracts";
import type { HrefExtras, MobileScreen } from "./url-state";
export interface MobileRoute { screen: MobileScreen | "webview"; itemId: number; linkId: number; url: string; }
export interface FeverHistoryState {
  view: ViewState;
  extras?: HrefExtras;
  scrollY?: number;
  panes?: Record<string, number>;
  depth?: number;
  route?: MobileRoute;
}
export function readFeverHistory(state: unknown = window.history.state): FeverHistoryState | null {
  if (!state || typeof state !== "object" || !("fever" in state)) return null;
  const fever = state.fever;
  return fever && typeof fever === "object" && "view" in fever ? fever as FeverHistoryState : null;
}
export function writeFeverHistory(mode: "push" | "replace", entry: FeverHistoryState, href: string) {
  const state = window.history.state;
  const next = { ...(state && typeof state === "object" ? state : {}), fever: entry };
  if (mode === "push") window.history.pushState(next, "", href);
  else window.history.replaceState(next, "", href);
}
export function updateFeverHistory(patch: Partial<FeverHistoryState>, href = window.location.href) {
  const current = readFeverHistory();
  if (current) writeFeverHistory("replace", { ...current, ...patch }, href);
}

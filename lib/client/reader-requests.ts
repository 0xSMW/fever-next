import type { ViewState } from "../contracts";
import { readerQueryString } from "./url-state";
export type ReaderLoadPurpose = "visit" | "reload" | "page";
export function readerRequest(target: ViewState, purpose: ReaderLoadPurpose, desktop: boolean, page = 1, cursor?: string | null): string {
  return `/api/reader?${readerQueryString(target, page, cursor)}&capture=${purpose === "visit" && desktop ? "true" : "false"}`;
}
/** Started writes settle in order. Only the latest unsent operation of each kind runs. */
export function createReaderPersistenceLane() {
  let running = false;
  const queue: Array<{ kind: "visit" | "focus"; run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }> = [];
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const entry = queue.shift()!;
        try { await entry.run(); entry.resolve(); } catch (error) { entry.reject(error); }
      }
    } finally { running = false; }
  }
  return {
    schedule(kind: "visit" | "focus", run: () => Promise<void>): Promise<void> {
      // A visit supersedes queued focus patches for the view being left.
      for (let index = queue.length - 1; index >= 0; index--) {
        if (queue[index].kind === kind || kind === "visit") { queue[index].resolve(); queue.splice(index, 1); }
      }
      const result = new Promise<void>((resolve, reject) => queue.push({ kind, run, resolve, reject }));
      void drain();
      return result;
    },
  };
}

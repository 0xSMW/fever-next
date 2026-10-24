import type { ItemDTO } from "@/lib/contracts";

export type ItemFlags = Pick<ItemDTO, "readAt" | "isSaved" | "isNew">;
export interface ItemTransition {
  before: ItemFlags;
  after: ItemFlags;
  unreadDelta: number;
  savedDelta: number;
}
const unread = (flags: ItemFlags) => Number(!flags.readAt && !flags.isSaved);
export function itemTransition(before: ItemFlags, patch: Partial<ItemFlags>): ItemTransition {
  const after = { readAt: before.readAt, isSaved: before.isSaved, isNew: before.isNew, ...patch };
  return { before: { readAt: before.readAt, isSaved: before.isSaved, isNew: before.isNew }, after,
    unreadDelta: unread(after) - unread(before), savedDelta: Number(after.isSaved) - Number(before.isSaved) };
}

interface PendingRead { revision: number; rollback: () => void; }
/** One ordered write lane. Failed transitions are reconciled after dependent writes settle. */
export function createItemMutationCoordinator(options: {
  read: (ids: number[]) => Promise<unknown>;
  reconcile: (revision: number) => Promise<void>;
  failed: (error: unknown) => void;
}) {
  let tail: Promise<void> = Promise.resolve();
  let settledTail = tail;
  let revision = 0;
  let dirty = false;
  let reconciling: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const revisions = new Map<number, number>();
  const reads = new Map<number, PendingRead>();
  function stage(id: number) { const next = ++revision; revisions.set(id, next); return next; }
  function enqueue<T>(work: () => Promise<T>, rollback?: () => void): Promise<T> {
    const result = tail.then(work);
    tail = result.then(() => undefined, error => {
      dirty = true;
      rollback?.();
      options.failed(error);
    });
    return result;
  }
  function sendReads() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const batch = [...reads];
    reads.clear();
    if (!batch.length) return;
    void enqueue(() => options.read(batch.map(([id]) => id)), () => {
      for (const [id, entry] of batch) if (revisions.get(id) === entry.revision) entry.rollback();
    }).catch(() => undefined);
  }
  async function settle() {
    for (;;) {
      sendReads();
      const pending = tail;
      await pending;
      if (pending !== tail || reads.size) continue;
      if (!dirty) { settledTail = pending; revisions.clear(); return; }
      dirty = false;
      const before = revision;
      try { await options.reconcile(before); }
      catch (error) { dirty = true; options.failed(error); throw error; }
      if (before !== revision) dirty = true;
    }
  }
  function whenSettled(): Promise<void> {
    if (!reconciling) reconciling = settle().finally(() => { reconciling = null; });
    return reconciling.then(() => {
      if (tail !== settledTail || reads.size || dirty) return whenSettled();
    });
  }
  return {
    configure(next: typeof options) { options = next; },
    get revision() { return revision; },
    queueRead(id: number, rollback: () => void) {
      const next = stage(id);
      reads.set(id, { revision: next, rollback });
      if (!timer) timer = setTimeout(() => { void whenSettled().catch(() => undefined); }, 250);
    },
    submit<T>(id: number, work: () => Promise<T>, rollback: () => void) {
      // Preserve older reads' order, including a batch already in flight.
      reads.delete(id);
      sendReads();
      const next = stage(id);
      const result = enqueue(work, () => { if (revisions.get(id) === next) rollback(); });
      void whenSettled().catch(() => undefined);
      return result;
    },
    enqueue,
    flushReads: whenSettled,
    whenSettled,
    dispose() { if (timer) clearTimeout(timer); timer = undefined; },
  };
}

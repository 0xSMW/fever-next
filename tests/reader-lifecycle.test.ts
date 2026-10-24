import assert from "node:assert/strict";
import { test } from "node:test";
import { createItemMutationCoordinator, itemTransition } from "../components/reader/item-mutations";
import { findItem, patchArticle, patchItemEverywhere } from "../components/reader/model";
import type { ItemDTO } from "../lib/contracts";
import { createReaderPersistenceLane, readerRequest } from "../lib/client/reader-requests";
import { commandForEvent, CORE_LETTERS } from "../lib/client/commands";
import { normalizeFocus } from "../lib/client/url-state";
import { createDefaultPreferences, createDefaultViewState, INHERITED_DISPLAY, resolveDisplayOptions } from "../lib/reader-policy";
import { createFeedDraft, feedletFeedInput, updateFeedInput } from "../components/forms/feed-draft";
import { tokenizeBlacklist, ruleProblem } from "../lib/blacklist-rules";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("a save atomically changes unread and saved counts, including a standalone article", () => {
  const item = { id: 800, feedId: 2, readAt: 0, isSaved: false, isNew: true } as ItemDTO;
  const list = { items: [] as ItemDTO[], links: [] };
  assert.equal(findItem(list.items, list.links, 800, item), item);
  const change = itemTransition(item, { readAt: 123, isSaved: true });
  assert.deepEqual([change.unreadDelta, change.savedDelta], [-1, 1]);
  const patched = patchArticle(item, 800, change.after)!;
  assert.equal(patched.isSaved, true);
  assert.equal(patched.readAt, 123);
  assert.deepEqual(patchItemEverywhere(list, 800, change.after), list, "An article does not enter the ordered page");
  assert.deepEqual(itemTransition(patched, { isSaved: false }).unreadDelta, 0, "Unsave keeps the item read");
});

test("flush includes a batch already in flight and orders later writes behind it", async () => {
  const first = deferred(), order: string[] = [];
  const coordinator = createItemMutationCoordinator({
    read: async ids => { order.push(`read:${ids}`); await first.promise; },
    reconcile: async () => { order.push("reconcile"); }, failed: () => undefined,
  });
  coordinator.queueRead(1, () => assert.fail("Unexpected rollback"));
  const flush = coordinator.flushReads();
  await Promise.resolve();
  coordinator.submit(2, async () => { order.push("save:2"); }, () => undefined);
  let settled = false;
  const secondFlush = coordinator.flushReads().then(() => { settled = true; });
  await Promise.resolve();
  assert.deepEqual(order, ["read:1"]);
  assert.equal(settled, false);
  first.resolve();
  await Promise.all([flush, secondFlush]);
  assert.deepEqual(order, ["read:1", "save:2"]);
  coordinator.dispose();
});

test("save removes an unsent read and sends one atomic command", async () => {
  const order: string[] = [];
  const coordinator = createItemMutationCoordinator({ read: async () => { order.push("read"); }, reconcile: async () => undefined, failed: () => undefined });
  coordinator.queueRead(3, () => undefined);
  await coordinator.submit(3, async () => { order.push("save"); }, () => undefined);
  await coordinator.flushReads();
  assert.deepEqual(order, ["save"]);
  coordinator.dispose();
});

test("an old failure cannot roll back a later change; reconciliation follows all dependent writes", async () => {
  const first = deferred(), order: string[] = [];
  const coordinator = createItemMutationCoordinator({
    read: async () => undefined, reconcile: async () => { order.push("reconcile"); }, failed: () => { order.push("failure"); },
  });
  const older = coordinator.submit(9, () => first.promise, () => { order.push("old rollback"); });
  const rejected = assert.rejects(older, /lost response/);
  const newer = coordinator.submit(9, async () => { order.push("new save"); }, () => { order.push("new rollback"); });
  first.reject(new Error("lost response"));
  await Promise.all([rejected, newer, coordinator.whenSettled()]);
  assert.deepEqual(order, ["failure", "new save", "reconcile"]);
  coordinator.dispose();
});

test("mutations arriving during reconciliation require a fresh reconciliation", async () => {
  const held = deferred(); let reconciles = 0;
  const coordinator = createItemMutationCoordinator({ read: async () => undefined, failed: () => undefined,
    reconcile: async () => { if (++reconciles === 1) await held.promise; },
  });
  await assert.rejects(coordinator.submit(4, async () => { throw Error("ambiguous"); }, () => undefined));
  await new Promise(resolve => setImmediate(resolve));
  await coordinator.submit(5, async () => undefined, () => undefined);
  held.resolve();
  await coordinator.whenSettled();
  assert.equal(reconciles, 2);
  coordinator.dispose();
});

test("capture writes settle in order and coalesce only unsent visits and focus", async () => {
  const lane = createReaderPersistenceLane(), first = deferred(), order: string[] = [];
  const started = lane.schedule("visit", async () => { order.push("visit1"); await first.promise; order.push("visit1 done"); });
  const focus = lane.schedule("focus", async () => { order.push("old focus"); });
  const skipped = lane.schedule("visit", async () => { order.push("visit2"); });
  const newest = lane.schedule("visit", async () => { order.push("visit3"); });
  assert.deepEqual(order, ["visit1"]);
  first.resolve();
  await Promise.all([started, focus, skipped, newest]);
  assert.deepEqual(order, ["visit1", "visit1 done", "visit3"]);
  const view = createDefaultViewState();
  assert.equal(new URL(readerRequest(view, "visit", true), "https://example.com").searchParams.get("capture"), "true");
  for (const purpose of ["reload", "page"] as const) assert.equal(new URL(readerRequest(view, purpose, true), "https://example.com").searchParams.get("capture"), "false");
  assert.equal(new URL(readerRequest(view, "visit", false), "https://example.com").searchParams.get("capture"), "false");
});

test("shared display inheritance, defaults and feed adapters preserve intentional differences", () => {
  const preferences = createDefaultPreferences(), other = createDefaultPreferences();
  preferences.services[0].name = "Changed";
  assert.notEqual(other.services[0].name, "Changed");
  const view = { ...createDefaultViewState(), section: "kindling" as const, groupId: 2 };
  const group = { ...INHERITED_DISPLAY, itemAllows: 0 }, feed = { ...INHERITED_DISPLAY, itemAllows: 2 };
  assert.equal(resolveDisplayOptions(preferences, view, group, feed).itemAllows, 2);
  assert.equal(resolveDisplayOptions(preferences, { ...view, section: "saved" }, group).itemAllows, preferences.itemAllows);
  const draft = createFeedDraft(preferences);
  assert.equal(draft.password, "");
  assert.equal(updateFeedInput(1, "https://example.com/feed", draft).title, "");
  assert.equal("title" in feedletFeedInput("https://example.com/feed", draft), false);
  assert.equal(normalizeFocus("links"), "links");
  assert.equal(normalizeFocus("item-4"), "items");
});

test("registry dispatch preserves aliases, Shift variants, IME guards and reserved service keys", () => {
  const key = (key: string, shiftKey = false, extra = {}) => commandForEvent({ key, shiftKey, ...extra } as KeyboardEvent);
  assert.equal(key("J"), "next-item");
  assert.equal(key("J", true), "source-down");
  assert.equal(key("S", true), null);
  assert.equal(key("ArrowLeft", true), "pane-left");
  assert.equal(key("Spacebar", true), "page-previous");
  assert.equal(key("Esc"), "escape");
  assert.equal(key("Enter", true), "toggle-content");
  assert.equal(key("?", true), "help");
  for (const guard of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { altKey: true }, { ctrlKey: true }, { defaultPrevented: true }]) assert.equal(key("j", false, guard), null);
  assert.equal(CORE_LETTERS.has("i"), true);
  assert.equal(CORE_LETTERS.has("e"), false);
});

test("shared blacklist lexical policy preserves source tokens without approximating RE2", () => {
  const tokens = tokenizeBlacklist("0\t#A##B# domain:EXAMPLE.com.\nhttps://example.com");
  assert.deepEqual(tokens.map(({ position, pattern }) => [position, pattern]), [[0, "AB"], [1, "EXAMPLE.com."], [2, "https://example.com"]]);
  assert.equal(ruleProblem(tokens[1]), null);
  assert.equal(ruleProblem(tokenizeBlacklist("#[")[0]), null, "Regex compilation belongs to authoritative server RE2");
});

test("reader history preserves framework keys and both layout-specific fields", async () => {
  const { readFeverHistory, writeFeverHistory, updateFeverHistory } = await import("../lib/client/reader-history");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let state: unknown = { framework: "retained" };
  const history = { get state() { return state; }, pushState: (next: unknown) => { state = next; }, replaceState: (next: unknown) => { state = next; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { history, location: { href: "https://reader.example/" } } });
  try {
    const view = createDefaultViewState();
    writeFeverHistory("push", { view, depth: 2, panes: { groups: 14 }, route: { screen: "article", itemId: 7, linkId: 0, url: "" } }, "/?section=hot");
    updateFeverHistory({ scrollY: 120 });
    assert.equal((state as { framework: string }).framework, "retained");
    assert.deepEqual(readFeverHistory()?.panes, { groups: 14 });
    assert.equal(readFeverHistory()?.route?.itemId, 7);
    assert.equal(readFeverHistory()?.scrollY, 120);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});


test("flush follows a write added while the previous settlement is completing", async () => {
  const second = deferred();
  const coordinator = createItemMutationCoordinator({ read: async () => undefined, reconcile: async () => undefined, failed: () => undefined });
  await coordinator.submit(1, async () => undefined, () => undefined);
  const write = coordinator.submit(2, () => second.promise, () => undefined);
  let settled = false;
  const flush = coordinator.flushReads().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  second.resolve();
  await Promise.all([write, flush]);
  assert.equal(settled, true);
  coordinator.dispose();
});

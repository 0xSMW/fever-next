# Fever architecture cleanup plan

Refactor Fever around typed command contracts, a single reader mutation lifecycle, and shared management workflows. This removes duplicated behavior, fixes inconsistent state handling, and makes future changes local to the code that owns them.

Source: `fever-next-2026-10-24.zip`, supplied 24 October 2026. All source locations below refer to that snapshot. New paths are proposed. This checklist tracks the implemented refactor. Source line references describe the starting snapshot; current module paths are named in the tasks.

## Recommended sequence

| Stage | Work | Reason for this order |
| --- | --- | --- |
| Foundation | Typed commands, create/update inputs, shared reader policy | Gives later extractions precise contracts |
| Reader | Article ownership, mutation ordering, request generations, view persistence | Fixes state inconsistencies while reducing duplicate writes |
| Management | Common data/error handling, blacklist editor, feed controls, preference revisions | Removes repeated UI workflows against stable contracts |
| Services | Shared subscription orchestration, lightweight catalog, domain transaction entry | Consolidates application policy and repeated database setup |
| Finishing | Worker execution, browser history, keyboard registry, obsolete helpers | Removes remaining duplication at established boundaries |

Retain the existing React hooks, Drizzle/PostgreSQL services, and HTTP adapters. The useful extraction boundaries are rules, state transitions, and complete repeated workflows. File length alone does not justify an abstraction.

## Typed command contracts and subscription orchestration

### Existing code

`lib/contracts.ts:67–81` defines broad feed inputs and an action union with `Record<string, unknown>` payloads. `lib/client/api.ts:174–176` erases result types. `lib/domain/commands.ts:10–59` repeats action dispatch, while `app/api/commands/route.ts:7` maintains another domain-action inventory.

This forces internal consumers to inspect successful results as unknown data. Examples include `useReader.jobFromResult` at `components/reader/useReader.ts:63–74`, `numberResult` at `components/manage/shared.tsx:590–593`, and ID coercion in `lib/integrations/subscribe.ts:19–20` and `lib/integrations/opml.ts:80,88–89`.

Feed creation plus refresh scheduling is also repeated across the command route, `app/api/feeds/route.ts:7–11`, subscribe, and OPML. `lib/integrations/refresh.ts:6–12` already implements the shared rule for refresh failures after a successful change.

### Implementation

- [x] Add `lib/command-contract.ts` with action-specific payload and result maps. Define domain results separately from browser responses: browser feed creation adds `job` and `warnings`, while the domain service returns the committed feed result. Model the existing `ok` envelopes, including account responses, accurately.
- [x] Derive `CommandAction`, discriminated `CommandRequest`, `CommandPayload<A>`, and `CommandResult<A>` from those maps. Re-export types from `lib/contracts.ts` where that preserves callers. Keep the module free of server implementations.
- [x] Replace the domain switch's repeated inventory with an explicitly keyed handler map checked against the domain contract. Export `isDomainCommandAction(value: string)` from that map and remove the route's separate `Set`.
- [x] Keep each handler's runtime input as `unknown` and run the existing parser. Provide a typed overload for trusted internal callers. Keep subscription and blacklist imports inside their handlers so ordinary item commands retain lazy loading.
- [x] Change `command`, `useReader.run`, and management wrappers to carry action-specific input/result types. Remove `jobFromResult` and replace result-number probing with direct typed properties.
- [x] Split feed and group creation/update inputs in `lib/contracts.ts` and `lib/domain/input.ts`. Require `url` for feed creation and `id` for update. Give parsers overloads or named entry functions sharing the common field parser. Remove `input.url!` and `input.id!` from `lib/domain/subscriptions.ts:77,109`.
- [x] Add `changeSubscription` in `lib/integrations/subscriptions.ts` for single-feed create/authenticate operations. Have both HTTP entrypoints call it. Keep domain mutation, postcommit refresh, and response construction in that order.
- [x] Reuse `refreshAfterChange` in subscribe and OPML, retaining their batch behavior and useful warning context. OPML must still queue once per distinct feed after processing outlines.
- [x] Add `membershipsAdded` to `CreateFeedResult`, using the rows actually inserted by `createFeed` at `subscriptions.ts:87,98`. Remove OPML's subsequent `membership.add` at `opml.ts:92–95` and its redundant membership bookkeeping.

Illustrative contracts:

```ts
type CreateFeedInput = Omit<FeedInput, "id">;
type UpdateFeedInput =
  Partial<Omit<FeedInput, "id">> & { id: number };

interface CreateFeedResult {
  id: number;
  created: boolean;
  membershipsAdded: number;
  operationId?: number;
}

type CommandPayload<A extends CommandAction> =
  CommandSpec[A]["payload"];

type CommandResult<A extends CommandAction> =
  CommandSpec[A]["result"];

declare function command<A extends CommandAction>(
  action: A,
  payload: CommandPayload<A>,
): Promise<CommandResult<A>>;

declare function changeSubscription<A extends SubscriptionAction>(
  owner: OwnerContext,
  action: A,
  payload: unknown,
): Promise<DomainCommandResult<A> & RefreshAfterChangeResult>;
```

Keep `requireMutation` before body parsing. Preserve existing status/error codes, feed creation's `201`/`200` distinction, partial OPML imports, existing subscription details, and Spark promotion. A queue failure must continue returning a successful primary change with a warning. Update only the internal response addition for `membershipsAdded`; Fever compatibility serialization remains independent.

## Shared reader defaults, display rules, and input policy

### Existing code

`components/reader/model.ts:15–30` explicitly mirrors `lib/domain/options.ts:19–29` display inheritance. `components/reader/ReaderApp.tsx:20–24` duplicates the default view from `lib/config.ts:27–30`. Section lists and device-key checks recur in `lib/contracts.ts`, `lib/client/url-state.ts`, `lib/integrations/reader-query.ts`, `lib/domain/options.ts`, `lib/domain/preferences.ts`, and `app/api/items/[id]/route.ts`.

The parser limits also differ:

| Field | Browser deep links | HTTP reader query | Domain view patch |
| --- | --- | --- | --- |
| Search | Truncates to 1,000 characters | Rejects above 1,000 | Accepts up to 2,048 |
| Hot start | 0–3,650 | Initially accepts any safe nonnegative integer | 0–36,500 |
| Hot range | 1–366 | Initially accepts zero through maximum safe integer | 1–36,500 |

The effective HTTP range already passes through the domain check. Consolidation should expose those policies explicitly and preserve accepted inputs.

### Implementation

- [x] Add `lib/reader-policy.ts` for browser-safe defaults, display keys, inheritance resolution, device-key syntax, and named domain/deep-link limits. Move default-preference/view factories from `lib/config.ts` and update their consumers in setup and migration code.
- [x] Define section and persisted-focus values once, deriving their unions. Keep the reader's local focus identifier capable of representing item/box IDs; normalize it to the persisted-focus union only at the wire boundary.
- [x] Have server option resolution and `model.resolveOption` call the same pure inheritance function. Preserve global → Kindling group → feed precedence and `-1` inheritance.
- [x] Replace duplicated initial view values and inherited-display objects with the shared factories/constants. Preserve fresh copies of nested sharing-service defaults.
- [x] Have strict HTTP/domain parsing share field constraints and device-key predicates. Preserve the forgiving deep-link parser and its explicitly named limits. Tighten HTTP Hot checks to the existing effective domain bounds so invalid values fail at their first boundary.
- [x] Update `lib/domain/options.ts`, `preferences.ts`, `lib/integrations/reader-query.ts`, `lib/client/url-state.ts`, and `app/api/items/[id]/route.ts` to use those definitions. Preserve browser URL keys such as `feed` versus API keys such as `feedId`.

```ts
declare function createDefaultViewState(): ViewState;
declare function createDefaultPreferences(): Preferences;

declare function resolveDisplayOptions(
  preferences: Preferences,
  view: Pick<ViewState, "section" | "groupId">,
  group?: DisplayOptions,
  feed?: DisplayOptions,
): DisplayOptions;

declare function isDeviceKey(value: string): boolean;
```

The browser imports pure reader policy without importing environment parsing. Runtime configuration stays lazy in `lib/config.ts`. This work changes module ownership, without changing environment variables or existing stored preferences.

## One owner for article state and ordered item mutations

### Existing code

`components/reader/mobile/MobileReader.tsx:234–255` fetches deep-linked items into local `standalone` state. Its article screen calls the shared store's save action, but `useReader.toggleSave` at `393–396` looks only in page items and Hot sources. An item found only in `standalone` therefore cannot be saved through that path.

`useReader.toggleSave:393–405` also sends an immediate read before saving. `lib/domain/state.ts:31–39,46–53` already makes a UI-origin save mark an unread item read in the same transaction.

Finally, `flushReads:342–357` returns no promise. Navigation, scope-read, and undo at `270–289,408–428` start dependent requests immediately. Existing rollback handlers apply inverse changes without knowing whether a newer action has superseded them.

### Implementation

- [x] Move standalone article acquisition into `useReader`, with a bounded article slot or small bounded lookup. Keep ordered page items and Hot sources as their existing list structures.
- [x] Extend the shared item lookup/patch helpers in `components/reader/model.ts` to cover page items, Hot source items, and the standalone article. Loading one article must not insert it into a page or change pagination.
- [x] Extract the mutation lifecycle into `components/reader/item-mutations.ts`. Keep batched reads, one ordered in-flight write sequence, and explicit draining. Reuse the server's existing owner-wide reading-state ordering.
- [x] Make `flushReads(): Promise<void>` include already in-flight batches, not just the current queue. Update navigation data loads, scope-read, undo, and `ReaderApp` sign-out handling to use that contract.
- [x] Keep visual navigation immediate. Start its dependent read after pending mutations settle, with failure reconciliation and notices handled by the mutation owner.
- [x] Change Save to one `items.save` command. Remove an unsent queued read for that item, wait for earlier writes where necessary, and apply one optimistic transition that changes saved/read flags and both count deltas.
- [x] Derive optimistic updates from before/after item flags in one pure transition function. Retain an operation revision per affected item so an old failure cannot reverse a newer result.
- [x] Reconcile affected item state and navigation counts after failed or ambiguous writes. If later optimistic actions depend on a failed transition, rebase them or reload after the queue drains; simply skipping an old rollback is insufficient.
- [x] Replace mobile's separate article fetch/error state with the shared article API. Keep its article/webview presentation and sibling order local to mobile.

```ts
type ItemFlags = Pick<ItemDTO, "readAt" | "isSaved" | "isNew">;

interface ItemTransition {
  before: ItemFlags;
  after: ItemFlags;
  unreadDelta: number;
  savedDelta: number;
}

interface ItemMutationCoordinator {
  flushReads(): Promise<void>;
  whenSettled(): Promise<void>;
}

declare function loadArticle(
  itemId: number,
  signal?: AbortSignal,
): Promise<ItemDTO>;
```

Update `useReader.ts`, `model.ts`, `ReaderApp.tsx`, and `mobile/MobileReader.tsx` together. Preserve read batching, scope cutoffs based on `renderedAt`, and the separate API-origin save semantics. The new coordination state is local to the browser; the database schema already supports atomic item changes.

## Reader request generations and view persistence

### Existing code

`useReader.ts:139–262,297–320,528–544` distributes request ownership across initial loads, paging, refreshes, bootstrap, and delayed persistence. `pendingFresh` is an unkeyed `ReaderView`, so `showFresh` can apply a previous view's result after navigation. An old paging request can also leave the current loading flag set.

Every desktop query generated by `queryFor` captures the view, including background reads and page continuation. A delayed full `view.save` then captures it again. `lib/domain/preferences.ts:50–68` advances reading-session timestamps and the stored version on each capture.

### Implementation

- [x] Give requests an explicit purpose, `"visit" | "reload" | "page"`. Centralize query construction, capture policy, request generation, and result adoption inside the existing hook or one focused request helper.
- [x] Retain capture for explicit desktop visits and initial desktop bootstrap. Use `capture=false` for background reloads, management reads, and page continuation. Keep mobile's device-local settings.
- [x] Store pending fresh data as `{ key, generation, result }`. Clear or invalidate it when navigation starts, and allow `showFresh` only when both key and generation match.
- [x] Scope loading/error/paging state to the active generation. Superseded read completions must not leave or clear the active generation's busy flags.
- [x] Track the normalized view/focus acknowledged by successful visits. Replace the delayed full-view save with a focus-only `view.save` patch when focus actually differs.
- [x] Sequence capture-bearing requests and focus saves through one persistence lane, coalescing unsent navigation changes. Let a started capture settle before the next persistence operation; aborting a browser request does not establish that its server write stopped.
- [x] Abort superseded read-only requests freely. Ignore superseded visual results even when a capture-bearing request is allowed to settle.
- [x] Preserve the `captureReaderView` calculation of `lastViewedAt` and `lastSessionAt` for visits. These timestamps determine which items are New. Keep ordinary data refreshes from advancing them.

```ts
type ReaderLoadPurpose = "visit" | "reload" | "page";

interface ReaderSnapshot {
  key: string;
  generation: number;
  result: ReaderView;
}
```

The public reader endpoint can retain its existing default capture behavior for existing callers. The modern client becomes explicit about request purpose. This preserves its first-page response contract while removing duplicate view writes and unintended background visits.

## Shared management loading, errors, and blacklist editing

### Existing code

Five standalone pages repeat `GET /api/reader?capture=false` and their own loading lifecycle: `FeedSubscribeFlow.tsx:41–72`, `ExtrasPage.tsx:17–31`, `ShortcutsPage.tsx:63–78`, `MaintenancePage.tsx:43–61`, and `BlacklistPage.tsx:53–72`.

`components/manage/useReaderData.ts:14–71` already provides most of this behavior. `components/pages/api-errors.ts:26–39` guesses several historical error shapes even though `ApiRequestError` exists in `lib/client/api.ts:27–47`.

`BlacklistPage.tsx` is also a complete 187-line second editor. `ManagementPanel` already supports standalone rendering, and `components/manage/Blacklist.tsx` supplies the canonical editor.

### Implementation

- [x] Move and extend `useReaderData` to `lib/client/useReaderData.ts`. Support supplied data, enabled state, a single cancellable request, explicit reload, and stale-response protection.
- [x] Put request disposal in an unconditional unmount cleanup. The current cleanup only exists when the hook initially owns fetching, although `reload` can start a request with supplied data.
- [x] Replace page-local loaders with this hook. Derive preferences/groups/feeds from its result while preserving separate unsaved form drafts.
- [x] Keep one owner for post-mutation reload: `ManagementDialog` already delegates to its parent when a view is supplied and reloads itself otherwise.
- [x] Add `lib/client/errors.ts` with a common `ClientError` and converter using `ApiRequestError`, ordinary `Error`, and a fallback. Replace `pages/api-errors.ts` and management's `toFormError` implementation. Preserve distinct page/modal presentation.
- [x] Reduce `BlacklistPage.tsx` to `PageShell`, `SessionGate`, and standalone `ManagementPanel`. Pass close navigation to the reader. Make `shared.Frame` honor `standalone` so the page has one prominent title.
- [x] Move the standalone editor's useful byte/count feedback, per-rule errors, and focus behavior into `BlacklistEditor` before removing its implementation.
- [x] Add `lib/blacklist-rules.ts` for tokenization, classification, positions, and existing limits. Reuse it in the editor and `lib/domain/blacklist.ts`. Keep RE2 compilation and matching server-side.
- [x] Preserve authoritative server behavior, including whitespace tokenization, ignored `"0"` tokens, all-`#` stripping, pattern byte bounds, and disabled imported rules. Remove the browser's JS-RegExp approximation of RE2 acceptance.
- [x] Retain structured issue positions from `BlacklistValidationError` in `lib/domain/commands.ts` as field errors such as `rules.0`, plus the existing summary. Remove parsing of English error messages.

```ts
interface ClientError {
  message: string;
  fields: Record<string, string>;
  status?: number;
  code?: string;
}

declare function useReaderData(options?: {
  initial?: ReaderView;
  enabled?: boolean;
}): {
  view: ReaderView | undefined;
  loading: boolean;
  error: ClientError | null;
  reload(): Promise<void>;
};
```

Update error imports in setup, recovery, diagnostics, session, status, and standalone management pages. Retain the existing endpoint and `ReaderView` response for this consolidation. A new global cache or form framework is unnecessary for the repeated lifecycle identified here.

## Shared feed controls and versioned preference drafts

### Existing code

`components/pages/FeedOptionsDialog.tsx` duplicates management display labels, inheritance, controls, and tab navigation from `components/manage/shared.tsx`. Feed payload assembly is repeated in `FeedSubscribeFlow.tsx:165–180` and `FeedForms.tsx:109–117`.

`PreferencesForm` captures draft values at `components/manage/Preferences.tsx:377–378` but omits the originating revision from its payload at `417–426`. The server already checks supplied revisions in `lib/domain/preferences.ts:103`.

### Implementation

- [x] Extract context-independent display controls and accessible tabs from `manage/shared.tsx` to `components/forms/DisplayOverrides.tsx` and `components/forms/Tabs.tsx`. Update feed/group/preferences forms and `FeedOptionsDialog` to import them.
- [x] Add `components/forms/feed-draft.ts` with a common editable feed shape and pure create/edit payload adapters. Reuse shared display defaults from `lib/reader-policy.ts`.
- [x] Keep the feedlet's `variantIndex` alongside its common draft. Make credential clearing explicit, initialize secrets empty, and preserve successful-submission credential clearing.
- [x] Preserve title semantics in named adapters: an empty edit title clears an override; a blank feedlet title is omitted.
- [x] Keep group/Spark behavior explicit. Management currently clears Spark on any membership change; feedlet clears it when adding a group. Share data/controls while retaining each caller's existing transition rule.
- [x] Keep the native feedlet `dialog` shell and management's portal/busy-close lifecycle. Share their controls and tab behavior.
- [x] Define `PersistedPreferences = Preferences & { version: number }` for the modern reader response while retaining revision-free defaults/import inputs. Capture that baseline revision, editable values, and service rows together when the editor opens. Send the original revision through a typed `PreferencesSaveInput`.
- [x] Preserve the draft on `CONFLICT` and provide an explicit reload that replaces baseline and draft together. Never attach a newer prop revision to an older draft.
- [x] Continue using separate commands for blacklist and account changes, which have their own side effects.
- [x] Remove CSS selectors made unused by the deleted controls, especially feedlet tab/inheritance rules in `components/pages/pages.css:572–600,614–618`. Preserve global custom-style hooks and shell-specific styling.

```ts
interface FeedDraft {
  title: string;
  preventsHotlinking: boolean;
  groupIds: number[];
  isSpark: boolean;
  display: DisplayOptions;
  username: string;
  password: string;
  clearCredentials: boolean;
}

declare function createFeedDraft(
  preferences: Preferences,
  options?: { feed?: FeedDTO; groupIds?: number[] },
): FeedDraft;

declare function createFeedInput(
  url: string,
  draft: FeedDraft,
): CreateFeedInput;

declare function updateFeedInput(
  id: number,
  url: string,
  draft: FeedDraft,
): UpdateFeedInput;
```

Keep discovered-feed title omission in a small named adapter or explicit option. The preference revision already exists in storage, so this activates the intended edit contract without a schema change.

## Focused catalog reads and domain transaction entry

### Existing code

`lib/domain/reader.ts:navigation` at `42–79` loads fetch state and article counts for callers needing only subscription identity or membership. Discovery needs URLs, subscribe needs group IDs, and OPML needs subscriptions and relationships. `app/api/items/route.ts:10–12` loads all navigation to identify one feed, then loads navigation again through `getReaderView`.

Navigation also repeatedly filters memberships per feed/group. State and subscription mutations repeatedly establish the same installation/authorization locks.

### Implementation

- [x] Add `lib/domain/catalog.ts` for owner-scoped feed/group/membership reads and a small subscription DTO. Share the underlying row loading and source-compatible sorting with full reader navigation.
- [x] Build membership indexes once by feed and by group. Use them in DTO assembly and keep article count aggregation in the full reader query.
- [x] Move discovery, subscribe, and OPML to the catalog. Change the OPML outline serializer's input from full `FeedDTO` to the fields it actually uses. Keep virtual All/Kindling groups at their respective presentation boundaries.
- [x] Replace `/api/items`' full navigation lookup with `getFeedIdentity(owner, id)`, preserving its `FEED_NOT_FOUND` response and subsequent reader query. Keep `/api/feeds` GET's public DTO shape.
- [x] Add `lib/domain/transaction.ts` with separate mutation and reader-snapshot entry functions. Move only the repeated transaction setup and existing owner advisory-lock policies into them.
- [x] Apply these helpers to `state.ts`, `subscriptions.ts`, `preferences.ts`, and ordinary `reader.ts` snapshots. Keep row locks, journal writes, and entity changes visible in the service body.
- [x] Move the shape-only `assertOwner` out of preferences and rename it `assertOwnerContext`. Re-export one `OwnerContext` type through existing domain/jobs type modules.
- [x] Pass the original owner object through every helper. `lib/auth/owner.ts:15–23` associates the checked session epoch with that exact object through a WeakMap.

```ts
declare function getSubscriptionCatalog(
  owner: OwnerContext,
): Promise<SubscriptionCatalog>;

declare function getFeedIdentity(
  owner: OwnerContext,
  id: number,
): Promise<{ id: number; isSpark: boolean }>;

declare function withDomainMutation<T>(
  owner: OwnerContext,
  lock: "subscriptions" | "reading-state" | undefined,
  work: (tx: DomainDb) => Promise<T>,
): Promise<T>;

declare function withReaderSnapshot<T>(
  owner: OwnerContext,
  work: (tx: DomainDb) => Promise<T>,
): Promise<T>;
```

Preserve the shared installation lock, current epoch checks, owner-row locking, and advisory keys `9183`/`9184`. Reader snapshots retain repeatable-read/read-only behavior.

Keep raw job transactions separate: `lib/jobs/transactions.ts:4–17` automatically retries serialization/deadlock failures. Hot, blacklist recomputation, maintenance, and migration also retain their specialized lock/connection lifetimes. A generic transaction wrapper would obscure those existing semantics.

## Shared worker execution with explicit lifecycle ownership

### Existing code

`worker/index.ts:21–64` implements feed refresh and job draining. `worker/batch.ts:101–113` repeats the claim/refresh/renew/release loop and imports `refreshOne` from the daemon entry module. Heartbeat SQL repeats at `worker/index.ts:79–82,108–111` and `worker/batch.ts:50–57`. The batch module also contains HTTP authentication and response handling at `151–166`.

### Implementation

- [x] Move `refreshOne` to `worker/refresh.ts`. Both execution modes import this function directly.
- [x] Add `worker/job.ts` with a shared job-drain function receiving the existing claim/refresh/renew/release dependencies. Return the feed count for the batch result.
- [x] Leave claim-job scheduling, daemon retry/polling, finite budgets, and batch concurrency in their existing supervisors.
- [x] Add shared heartbeat/start-stop helpers in `lib/jobs/heartbeat.ts`. Accept a query-capable session so batch heartbeats continue using their dedicated advisory-lock connection.
- [x] Move `createRefreshHandler` into `lib/integrations/scheduled-refresh.ts` and update `app/api/internal/refresh/route.ts`. Preserve authentication before any database access and existing status/response behavior.
- [x] In `lib/ingest/persist.ts:120–191`, read configuration once per refresh operation and reuse retention/HTTPS values within item processing. Keep configuration operation-scoped.
- [x] Retain per-feed renewal, cancellation propagation, fencing, post-rollback failure recording, and attempts to perform every cleanup even after another cleanup fails.

```ts
declare function refreshOne(
  lease: FeedLease,
  signal: AbortSignal,
): Promise<void>;

declare function drainJob(
  job: JobLease,
  signal: AbortSignal,
  operations: JobOperations,
): Promise<number>;

declare function heartbeat(
  context: InstallationContext,
  workerId: string,
  session?: Pick<PoolClient, "query">,
): Promise<void>;
```

The job helper releases a fully drained job. Supervisors retain lease cleanup on interruption. Batch connection capacity, session advisory locking, and the separate host-coordination pool remain explicit because they govern different resource lifetimes.

## Browser history, keyboard policy, and final deletions

### Browser history

`useReader.ts`, `ReaderApp.tsx`, `DesktopReader.tsx`, and `mobile/MobileReader.tsx` all write `history.state.fever`. Desktop and mobile use different interfaces for the same stored object.

- [x] Add `lib/client/reader-history.ts` with one history entry containing common view/depth/extras fields plus optional desktop pane scroll and mobile route state.
- [x] Move the mobile route type to a browser-safe model module. Have history helpers preserve unrelated `history.state` keys and derive URLs through the existing `readerHref`.
- [x] Replace direct history writes and consolidate mobile's immediate/post-pagination article replacement. Keep desktop/mobile `popstate` behavior and scroll decisions at their existing layout boundaries.

```ts
declare function readReaderHistory(): ReaderHistoryEntry | null;
declare function patchReaderHistory(
  patch: Partial<ReaderHistoryEntry>,
): void;
declare function writeReaderHistory(
  mode: "push" | "replace",
  entry: ReaderHistoryEntry,
): void;
```

### Keyboard bindings

`lib/client/commands.ts` maintains a command union, display registry, reserved-key set, and two key-dispatch switches. Its own header promises one registry for help and behavior.

- [x] Add machine-readable key/modifier bindings to `COMMANDS`. Derive `CommandId`, dispatch lookup, help labels, and shortcut conflict keys from the registry.
- [x] Update `DesktopReader.tsx`, `reader/dialogs.tsx`, `pages/ShortcutsPage.tsx`, and preference shortcut handling.
- [x] Preserve key aliases, Shift behavior, IME/platform guards, and sharing-service precedence. Keep the contextual command-action switch in the desktop controller.

### Deletions tied to the preceding changes

- [x] Remove `pages/api-errors.responseError` and `lib/validation.errorResponse` with its `lib/domain/index.ts` re-export; the supplied code has no consumers.
- [x] Remove `numberResult` once all command consumers use typed results.
- [x] Remove `model.scopeFeeds`' ignored `_loadedItems` argument and `visibleScopeFeeds`' corresponding argument. Remove resulting props/memo dependencies in desktop feed navigation, `FeedsPane`, `ContentPane`, and mobile `FeedsScreen`.
- [x] Reuse existing unread selectors in controller menus instead of rebuilding their calculations.
- [x] Delete imports, local interfaces, copied literals, and CSS rules whose final consumer disappeared in these changes. Keep compatibility algorithms, generated collation data, and distinct content-processing policies attached to their documented purpose.

## Dependency, interface, and configuration decisions

| Area | Decision |
| --- | --- |
| Runtime packages | Existing dependencies support the plan |
| Package/configuration files | No required changes to `package.json`, lockfile, `tsconfig.json`, or framework configuration |
| Environment | Existing names and lazy runtime parsing stay in place |
| PostgreSQL schema | Existing revisions, journals, memberships, and leases support these changes |
| Browser commands | Add action-specific TypeScript contracts; retain runtime parsing and current envelopes |
| Feed creation result | Add `membershipsAdded` internally and to modern responses where included |
| Blacklist errors | Add position-specific entries to the existing `fields` map |
| Reader API | Existing response and capture defaults remain available; modern callers state request purpose |
| Client state | Add bounded standalone article state, mutation revisions, keyed request snapshots, and preference draft baseline |
| Imports | Browser code uses pure policy/contracts; service and worker implementations remain server-side; command handlers keep lazy heavy imports |

The concrete reductions are removal of the second blacklist editor, five duplicate reader-data loaders, guessed command-result shapes, duplicated display/tab logic, redundant OPML membership commands, duplicate worker loops, and repeated keyboard mappings. Correctness improves through the same ownership changes: deep-linked articles participate in mutations, saves become one atomic command, read-dependent actions follow queued writes, stale reader responses stay scoped, and preference edits retain their originating revision.


## Delivery verification — 24 October 2026

All 78 implementation tasks above are complete. No package, environment, framework configuration, or PostgreSQL schema changes were required.

| Check | Result |
| --- | --- |
| TypeScript and production compilation | `pnpm build` passed, including Next.js TypeScript validation |
| Lint | `pnpm lint` passed without warnings |
| Default regression suite | 134 passed, 25 optional environment-gated tests skipped, zero failures |
| Isolated PostgreSQL domain integration | 14 passed: migration guards, types, memberships, subscriptions, state/undo, preference conflicts, session boundaries, search/paging, queue fencing, deletion and sequence preservation |
| Isolated PostgreSQL authorization integration | Parent test and four subtests passed: session revocation, recovery restrictions, commit/rotation ordering, selection cleanup |
| Worker lifecycle unit coverage | Existing batch cleanup/cancellation tests passed; added completed-feed accounting on interrupted jobs |
| Vercel deployment | Production build of the existing test project passed on Node 24.22.1 / Next.js 16.4.3 |
| Browser acceptance | Existing signed-in in-app browser: Hot, Kindling, Saved, compact article acquisition/save/reload, preference conflict/reload, shared tabs/display inheritance, real-feed discovery without subscription, blacklist and support pages; rapid navigation/Back; Save followed immediately by Saved navigation |

Test deployment: <https://feedafever-test.vercel.app/>. Immutable deployment: <https://feedafever-test-84maw2hdn-ai-marketing.vercel.app/>.

The first domain-integration attempts failed while connecting to Neon, before fixture creation. The same guarded suite passed with Node's `--network-family-autoselection-attempt-timeout=2000`; application connection settings were unchanged. Both database suites cleaned up their isolated fixtures. Browser save checks used an existing read article and restored its unsaved state; the preference-conflict check preserved the original values. No test subscriptions were added.

The default suite's skipped lanes remain optional historical rehearsals; this refactor does not claim they were rerun. Existing PHP-oracle, compatibility, ingestion, migration-support and security-contract assertions remain in the default suite. UI behavior was checked in the in-app browser; no native client or physical device was used.

Implementation details: focus-only `view.save` patches preserve reading-session timestamps; full-view legacy saves retain capture behavior. `worker/job.ts` reports each completed feed to the finite supervisor as it finishes, preserving partial progress when a later feed is cancelled. `lib/client/reader-history.ts` owns the shared history entry and preserves framework state alongside it.

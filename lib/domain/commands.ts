import "server-only";
import type { DomainCommandAction, DomainCommandPayload, DomainCommandResult } from "../command-contract";
import { DomainError, enumeration, ids, integer, object, rejectUnknown, text } from "../validation";
import { SECTIONS } from "./options";
import { getViewState, savePreferences, saveView } from "./preferences";
import { markScopeRead, mutateItems, undoOperation, undoRecentlyRead } from "./state";
import type { OwnerContext } from "./types";

const itemMutation = (action: "read" | "unread" | "save" | "unsave") => (owner: OwnerContext, payload: unknown) => {
  const input = object(payload);
  rejectUnknown(input, ["ids"]);
  return mutateItems(owner, action, ids(input.ids));
};

/** One checked inventory; heavy handlers stay lazy so item commands do not load them. */
const handlers = {
  "feed.create": async (owner, payload) => (await import("./subscriptions")).createFeed(owner, payload),
  "feed.update": async (owner, payload) => (await import("./subscriptions")).updateFeed(owner, payload),
  "feed.delete": async (owner, payload) => (await import("./subscriptions")).deleteFeed(owner, payload),
  "feed.authenticate": async (owner, payload) => (await import("./subscriptions")).authenticateFeed(owner, payload),
  "group.create": async (owner, payload) => (await import("./subscriptions")).createGroup(owner, payload),
  "group.update": async (owner, payload) => (await import("./subscriptions")).updateGroup(owner, payload),
  "group.delete": async (owner, payload) => (await import("./subscriptions")).deleteGroup(owner, payload),
  "membership.add": async (owner, payload) => (await import("./subscriptions")).changeMembership(owner, payload, true),
  "membership.remove": async (owner, payload) => (await import("./subscriptions")).changeMembership(owner, payload, false),
  "sparks.update": async (owner, payload) => (await import("./subscriptions")).updateSparks(owner, payload),
  "sparks.delete": async (owner, payload) => (await import("./subscriptions")).deleteSparks(owner, payload),
  "preferences.save": savePreferences,
  "view.save": saveView,
  "items.read": itemMutation("read"),
  "items.unread": itemMutation("unread"),
  "items.save": itemMutation("save"),
  "items.unsave": itemMutation("unsave"),
  "scope.read": async (owner, payload) => {
    const input = object(payload);
    rejectUnknown(input, ["scope", "id", "before"]);
    const scope = enumeration(input.scope, "scope", ["all", "group", "feed", "sparks"] as const);
    return markScopeRead(owner, { scope, before: integer(input.before, "before"), ...(input.id === undefined ? {} : { id: integer(input.id, "id", 1) }) });
  },
  "items.undo": async (owner, payload) => {
    const input = object(payload);
    rejectUnknown(input, ["section", "operationId"]);
    if (input.operationId !== undefined) return undoOperation(owner, integer(input.operationId, "operationId", 1));
    const section = input.section === undefined ? (await getViewState(owner)).view.section : enumeration(input.section, "section", SECTIONS);
    return undoRecentlyRead(owner, section);
  },
  "blacklist.save": async (owner, payload) => {
    const input = object(payload);
    rejectUnknown(input, ["rules"]);
    const rules = text(input.rules, "rules", 65536);
    const { saveBlacklist, BlacklistValidationError } = await import("./blacklist");
    try { return await saveBlacklist(owner, rules); }
    catch (error) {
      if (error instanceof BlacklistValidationError) {
        throw new DomainError(error.message, "INVALID_BLACKLIST", 422, {
          rules: error.message,
          ...Object.fromEntries(error.issues.map(issue => [`rules.${issue.position}`, issue.message])),
        });
      }
      throw error;
    }
  },
} satisfies { [A in DomainCommandAction]: (owner: OwnerContext, payload: unknown) => Promise<DomainCommandResult<A>> };

export function isDomainCommandAction(value: string): value is DomainCommandAction {
  return Object.prototype.hasOwnProperty.call(handlers, value);
}

export function executeDomainCommand<A extends DomainCommandAction>(owner: OwnerContext, action: A, payload: DomainCommandPayload<A>): Promise<DomainCommandResult<A>>;
export function executeDomainCommand(owner: OwnerContext, action: string, payload: unknown): Promise<DomainCommandResult<DomainCommandAction>>;
export async function executeDomainCommand(owner: OwnerContext, action: string, payload: unknown): Promise<DomainCommandResult<DomainCommandAction>> {
  if (!isDomainCommandAction(action)) throw new DomainError(`Unsupported reader command: ${action}.`, "UNSUPPORTED_COMMAND", 400);
  return handlers[action](owner, payload);
}

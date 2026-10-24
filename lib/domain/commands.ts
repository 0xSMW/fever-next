import "server-only";
import type { CommandAction } from "../contracts";
import { DomainError, enumeration, ids, integer, object, rejectUnknown, text } from "../validation";
import { SECTIONS } from "./options";
import { getViewState, savePreferences, saveView } from "./preferences";
import { markScopeRead, mutateItems, undoOperation, undoRecentlyRead } from "./state";
import type { OwnerContext } from "./types";

/** Authentication and CSRF belong at the HTTP boundary; ownership is enforced again by each service. */
export async function executeDomainCommand(owner: OwnerContext, action: CommandAction | string, payload: unknown): Promise<Record<string, unknown>> {
  switch (action) {
    case "feed.create": return (await import("./subscriptions")).createFeed(owner, payload);
    case "feed.update": return (await import("./subscriptions")).updateFeed(owner, payload);
    case "feed.delete": return (await import("./subscriptions")).deleteFeed(owner, payload);
    case "feed.authenticate": return (await import("./subscriptions")).authenticateFeed(owner, payload);
    case "group.create": return (await import("./subscriptions")).createGroup(owner, payload);
    case "group.update": return (await import("./subscriptions")).updateGroup(owner, payload);
    case "group.delete": return (await import("./subscriptions")).deleteGroup(owner, payload);
    case "membership.add": return (await import("./subscriptions")).changeMembership(owner, payload, true);
    case "membership.remove": return (await import("./subscriptions")).changeMembership(owner, payload, false);
    case "sparks.update": return (await import("./subscriptions")).updateSparks(owner, payload);
    case "sparks.delete": return (await import("./subscriptions")).deleteSparks(owner, payload);
    case "preferences.save": return savePreferences(owner, payload);
    case "view.save": return saveView(owner, payload);
    case "items.read": case "items.unread": case "items.save": case "items.unsave": {
      const input = object(payload);
      rejectUnknown(input, ["ids"]);
      return mutateItems(owner, action.slice(6) as "read" | "unread" | "save" | "unsave", ids(input.ids));
    }
    case "scope.read": {
      const input = object(payload);
      rejectUnknown(input, ["scope", "id", "before"]);
      const scope = enumeration(input.scope, "scope", ["all", "group", "feed", "sparks"] as const);
      return markScopeRead(owner, { scope, before: integer(input.before, "before"), ...(input.id === undefined ? {} : { id: integer(input.id, "id", 1) }) });
    }
    case "items.undo": {
      const input = object(payload);
      rejectUnknown(input, ["section", "operationId"]);
      if (input.operationId !== undefined) return undoOperation(owner, integer(input.operationId, "operationId", 1));
      const section = input.section === undefined ? (await getViewState(owner)).view.section : enumeration(input.section, "section", SECTIONS);
      return undoRecentlyRead(owner, section);
    }
    case "blacklist.save": {
      const input = object(payload);
      rejectUnknown(input, ["rules"]);
      try {
        const rules = text(input.rules, "rules", 65536);
        const { saveBlacklist } = await import("./blacklist");
        return { ...await saveBlacklist(owner, rules) };
      }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "INVALID_BLACKLIST") {
          throw new DomainError(error instanceof Error ? error.message : "Invalid blacklist rules.", "INVALID_BLACKLIST", 422, { rules: error instanceof Error ? error.message : "Review the blacklist syntax." });
        }
        throw error;
      }
    }
    default: throw new DomainError(`Unsupported reader command: ${action}.`, "UNSUPPORTED_COMMAND", 400);
  }
}

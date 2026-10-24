import type { CreateFeedInput, UpdateFeedInput, CreateGroupInput, UpdateGroupInput } from "../contracts";
import { boolean, feedUrl, ids, integer, object, rejectUnknown, text } from "../validation";
import { DISPLAY_KEYS, displayOptions } from "./options";

export function parseFeedInput(value: unknown, update?: false): CreateFeedInput;
export function parseFeedInput(value: unknown, update: true): UpdateFeedInput;
export function parseFeedInput(value: unknown, update = false): CreateFeedInput | UpdateFeedInput {
  const input = object(value);
  rejectUnknown(input, ["id", "url", "title", "groupIds", "isSpark", "preventsHotlinking", "username", "password", "clearCredentials", ...DISPLAY_KEYS]);
  const result: Partial<CreateFeedInput> & { id?: number } = displayOptions(input);
  if (update) result.id = integer(input.id, "id", 1);
  if (!update || input.url !== undefined) result.url = feedUrl(input.url);
  if (input.title !== undefined) result.title = text(input.title, "title", 1024).trim();
  if (input.groupIds !== undefined) result.groupIds = ids(input.groupIds, "groupIds", 1000);
  if (input.isSpark !== undefined) result.isSpark = boolean(input.isSpark, "isSpark");
  if (input.preventsHotlinking !== undefined) result.preventsHotlinking = boolean(input.preventsHotlinking, "preventsHotlinking");
  if (input.username !== undefined) result.username = text(input.username, "username", 4096);
  if (input.password !== undefined) result.password = text(input.password, "password", 16384);
  if (input.clearCredentials !== undefined) result.clearCredentials = boolean(input.clearCredentials, "clearCredentials");
  return result as CreateFeedInput | UpdateFeedInput;
}

export function parseGroupInput(value: unknown, update?: false): CreateGroupInput;
export function parseGroupInput(value: unknown, update: true): UpdateGroupInput;
export function parseGroupInput(value: unknown, update = false): CreateGroupInput | UpdateGroupInput {
  const input = object(value);
  rejectUnknown(input, ["id", "title", "feedIds", ...DISPLAY_KEYS]);
  return {
    ...displayOptions(input), title: text(input.title, "title", 255, false).trim(),
    ...(update ? { id: integer(input.id, "id", 1) } : {}),
    ...(input.feedIds === undefined ? {} : { feedIds: ids(input.feedIds, "feedIds", 10000) }),
  };
}

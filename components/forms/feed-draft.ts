import type { CreateFeedInput, UpdateFeedInput, DisplayOptions, FeedDTO, Preferences } from "@/lib/contracts";
import { INHERITED_DISPLAY } from "@/lib/reader-policy";

export interface FeedDraft {
  title: string;
  groupIds: number[];
  isSpark: boolean;
  preventsHotlinking: boolean;
  display: DisplayOptions;
  username: string;
  password: string;
  clearCredentials: boolean;
}
export function createFeedDraft(preferences?: Preferences | null, feed?: FeedDTO, groupIds: number[] = []): FeedDraft {
  return { title: feed?.customTitle ?? "", groupIds: feed?.groupIds ?? groupIds,
    isSpark: feed?.isSpark ?? preferences?.autoSpark ?? false, preventsHotlinking: !!feed?.preventsHotlinking,
    display: feed ? { sortOrder: feed.sortOrder, itemAllows: feed.itemAllows, itemExcerpts: feed.itemExcerpts, unreadCounts: feed.unreadCounts } : { ...INHERITED_DISPLAY }, username: "", password: "", clearCredentials: false };
}
/** Management's blank title deliberately clears an existing override. */
export function managementFeedInput(url: string, draft: FeedDraft): CreateFeedInput {
  const input: CreateFeedInput = { url, title: draft.title.trim(), groupIds: draft.groupIds,
    isSpark: draft.isSpark, preventsHotlinking: draft.preventsHotlinking, ...draft.display };
  if (draft.clearCredentials) input.clearCredentials = true;
  else if (draft.username || draft.password) { input.username = draft.username; input.password = draft.password; }
  return input;
}
export function updateFeedInput(id: number, url: string, draft: FeedDraft): UpdateFeedInput {
  return { ...managementFeedInput(url, draft), id };
}
/** Feedlet leaves an unspecified title and credentials out of the request. */
export function feedletFeedInput(url: string, draft: FeedDraft): CreateFeedInput {
  const input = managementFeedInput(url, draft);
  if (!draft.title.trim()) delete input.title;
  if (!draft.username) { delete input.username; delete input.password; }
  return input;
}

/** Shared browser/server wire contracts. Never import database or secrets here. */
import type { Section } from "./reader-policy";
export type { Section } from "./reader-policy";
export type DisplayOverride = -1 | 0 | 1 | 2;
export interface DisplayOptions {
  itemExcerpts: number;
  itemAllows: number;
  unreadCounts: number;
  sortOrder: number;
}
export interface SharingService { id?: number; name: string; url: string; key: string; enabled?: boolean; reason?: string; }
export interface Preferences {
  version?: number;
  useCelsius: boolean; refreshInterval: number; itemExpiration: number;
  newWindow: boolean; unreadCounts: boolean; layout: number; itemExcerpts: boolean;
  itemAllows: number; sortOrder: number; autoSpark: boolean; perPage: number;
  autoRead: boolean; mobileReadOnScroll: boolean; mobileReadOnBackOut: boolean;
  mobileViewInApp: boolean; autoReload: boolean; autoRefresh: boolean;
  autoUpdate: boolean; toggleClick: boolean; anonymize: boolean; sessionTimeout: number;
  blacklist: string; share: boolean; shareProtected: boolean; services: SharingService[];
}
export type PersistedPreferences = Preferences & { version: number };
export interface ViewState {
  section: Section; previous: Section; groupId: number; feedId: number;
  search: string; hasFocus: string; showFeeds: boolean; showRead: boolean;
  hotStart: number; hotRange: number;
}
export interface FeedDTO extends DisplayOptions {
  id: number; title: string; url: string; siteUrl: string; faviconId: number;
  customTitle?: string | null; sourceTitle?: string;
  groupIds: number[]; isSpark: boolean; requiresAuth: boolean; preventsHotlinking: boolean;
  unreadCount: number; savedCount: number; totalCount: number;
  lastRefreshedAt: number; lastUpdatedAt: number; lastError?: string | null;
  fetchStatus?: string;
}
export interface GroupDTO extends DisplayOptions {
  id: number; title: string; feedIds: number[]; unreadCount: number; totalCount: number;
}
export interface ItemDTO {
  id: number; feedId: number; title: string; author: string; url: string;
  html: string; excerpt: string; publishedAt: number; addedAt: number; readAt: number;
  isSaved: boolean; isNew: boolean; feedTitle: string; faviconId: number;
}
export interface HotLinkDTO {
  id: number; feedId: number; itemId: number; title: string; url: string; html: string;
  temperature: number; isItem: boolean; isLocal: boolean; isSaved: boolean;
  itemIds: number[]; sources: ItemDTO[];
}
export interface ReaderQuery extends Partial<ViewState> { page?: number; cursor?: string; deviceKey?: string; }
export interface ReaderView {
  view: ViewState; preferences: PersistedPreferences; groups: GroupDTO[]; feeds: FeedDTO[];
  items: ItemDTO[]; links: HotLinkDTO[]; totalItems: number; unreadCount: number;
  savedCount: number; page: number; hasMore: boolean; nextCursor?: string | null;
  renderedAt: number; lastRefreshedAt: number; lastSessionAt: number;
  refreshJob?: RefreshJobDTO | null;
  visibleFeedIds?: number[];
  searchCounts?: Record<string, number>;
}
export interface RefreshJobDTO {
  id: number; status: "queued" | "running" | "completed" | "failed" | "cancelled";
  totalFeeds: number; completedFeeds: number; currentFeedId?: number | null;
  currentFeedTitle?: string | null; error?: string | null; createdAt: number;
  startedAt?: number | null; finishedAt?: number | null;
}
export interface SessionDTO {
  configured: boolean; authenticated: boolean; csrfToken: string;
  owner?: { id: number; email: string };
}
export interface CreateFeedInput extends Partial<DisplayOptions> {
  url: string; title?: string; groupIds?: number[]; isSpark?: boolean;
  preventsHotlinking?: boolean; username?: string; password?: string; clearCredentials?: boolean;
}
export type UpdateFeedInput = Partial<CreateFeedInput> & { id: number };
export type FeedInput = CreateFeedInput;
export interface CreateGroupInput extends Partial<DisplayOptions> { title: string; feedIds?: number[]; }
export type UpdateGroupInput = CreateGroupInput & { id: number };
export type GroupInput = CreateGroupInput;
export interface FeedCandidate { url: string; title: string; type: string; subscribed: boolean; guessed: boolean; }
export interface ImportResult { feedsAdded: number; groupsAdded: number; membershipsAdded: number; skipped: number; warnings: string[]; }
export type { CommandAction, CommandRequest, CommandPayload, CommandResult } from "./command-contract";
export interface ApiError { error: string; code?: string; fields?: Record<string, string>; }

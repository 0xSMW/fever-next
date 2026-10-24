/** Action-specific wire contracts. This module contains no server implementation. */
import type { CreateFeedInput, UpdateFeedInput, CreateGroupInput, UpdateGroupInput, PersistedPreferences, Preferences, RefreshJobDTO, Section, ViewState } from "./contracts";

export interface CreateFeedResult { id: number; created: boolean; membershipsAdded: number; operationId?: number; }
export interface CreateGroupResult { id: number; created: boolean; operationId?: number; }
export interface ChangedResult { changed: number; operationId: number | null; }
export interface EntityResult { id: number; operationId: number; }
export interface DeletedResult { deleted: number; operationId: number | null; }
export interface FeedDeletedResult extends DeletedResult { itemsDeleted: number; savedItemsDeleted: number; }
export interface PreferencesSaveInput extends Partial<Omit<Preferences, "version">> { version?: number; }
export interface RefreshAfterChangeResult { job: RefreshJobDTO | null; warnings: string[]; }
export type SubscriptionAction = "feed.create" | "feed.authenticate";
export type MaintenanceOperation = "empty" | "flush" | "unorphan" | "uninstall";
type Spec<P, R> = { payload: P; result: R };
type ItemIds = { ids: number[] };
type ConfirmedId = { id: number; confirm: true };
export interface DomainCommandSpec {
  "feed.create": Spec<CreateFeedInput, CreateFeedResult>;
  "feed.update": Spec<UpdateFeedInput, EntityResult>;
  "feed.delete": Spec<ConfirmedId, FeedDeletedResult>;
  "feed.authenticate": Spec<{ id: number; username?: string; password?: string; clearCredentials?: boolean }, EntityResult>;
  "group.create": Spec<CreateGroupInput, CreateGroupResult>;
  "group.update": Spec<UpdateGroupInput, EntityResult>;
  "group.delete": Spec<ConfirmedId & { unsubscribe?: boolean }, FeedDeletedResult & { feedsDeleted: number }>;
  "membership.add": Spec<{ feedId: number; groupId: number }, ChangedResult>;
  "membership.remove": Spec<{ feedId: number; groupId: number }, ChangedResult>;
  "sparks.update": Spec<{ feedIds: number[] }, ChangedResult>;
  "sparks.delete": Spec<{ confirm: true }, FeedDeletedResult>;
  "items.read": Spec<ItemIds, ChangedResult>;
  "items.unread": Spec<ItemIds, ChangedResult>;
  "items.save": Spec<ItemIds, ChangedResult>;
  "items.unsave": Spec<ItemIds, ChangedResult>;
  "scope.read": Spec<{ scope: "all" | "group" | "feed" | "sparks"; id?: number; before: number }, ChangedResult>;
  "items.undo": Spec<{ section?: Section; operationId?: number }, ChangedResult>;
  "preferences.save": Spec<PreferencesSaveInput, { preferences: PersistedPreferences; version: number; operationId: number }>;
  "view.save": Spec<Partial<ViewState> & { deviceKey?: string }, { view: ViewState; lastSessionAt: number }>;
  "blacklist.save": Spec<{ rules: string }, { rules: string; ruleCount: number; scanned: number; matched: number; version: number }>;
}
export type DomainCommandAction = keyof DomainCommandSpec;
export type DomainCommandPayload<A extends DomainCommandAction> = DomainCommandSpec[A]["payload"];
export type DomainCommandResult<A extends DomainCommandAction> = DomainCommandSpec[A]["result"];
type BrowserDomainSpec = {
  [A in DomainCommandAction]: Spec<DomainCommandPayload<A>, { ok: true } & DomainCommandResult<A> & (A extends SubscriptionAction ? RefreshAfterChangeResult : object)>;
};
export interface CommandSpec extends BrowserDomainSpec {
  "refresh.start": Spec<{ scope: "all" | "group" | "feed"; id?: number; force?: boolean; faviconOnly?: boolean }, { ok: true; job: RefreshJobDTO }>;
  "refresh.cancel": Spec<{ id: number }, { ok: true; job: RefreshJobDTO }>;
  "favicons.clear": Spec<Record<string, never>, { ok: true; cleared: number; operationId: number } & RefreshAfterChangeResult>;
  "maintenance.preview": Spec<{ operation: MaintenanceOperation; currentPassword: string }, { ok: true; token: string; summary: string; counts: Record<string, number>; confirmation: string; expiresIn: number }>;
  "maintenance.execute": Spec<{ operation: MaintenanceOperation; token: string; confirmation: string }, { ok: true; operation: MaintenanceOperation; counts: Record<string, number>; backupId: number; operationId: number; signedOut: boolean }>;
  "account.update": Spec<{ currentPassword: string; email?: string; password?: string }, { ok: true; reauthenticate: true; apiCredentialRotated: true }>;
}
export type CommandAction = keyof CommandSpec;
export type CommandPayload<A extends CommandAction> = CommandSpec[A]["payload"];
export type CommandResult<A extends CommandAction> = CommandSpec[A]["result"];
export type CommandRequest = { [A in CommandAction]: { action: A; payload: CommandPayload<A> } }[CommandAction];

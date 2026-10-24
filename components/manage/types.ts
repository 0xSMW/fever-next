import type { FeedDTO, GroupDTO, HotLinkDTO, ReaderView } from "@/lib/contracts";

export const MANAGEMENT_KINDS = [
  "preferences", "add-feed", "edit-feed", "delete-feed", "add-group", "edit-group", "delete-group",
  "edit-sparks", "delete-sparks", "auth-feed", "blacklist", "import", "export", "maintenance",
] as const;
export type ManagementKind = (typeof MANAGEMENT_KINDS)[number];

export const MAINTENANCE_OPERATIONS = ["empty", "flush", "unorphan", "uninstall"] as const;
export type MaintenanceOperation = (typeof MAINTENANCE_OPERATIONS)[number];

export const PREFERENCE_TABS = ["behavior", "display", "refreshing", "sharing", "login"] as const;
export type PreferenceTab = (typeof PREFERENCE_TABS)[number];

/**
 * What the reader or a standalone page asks the management UI to show.
 * `kind` is a string so callers can pass legacy `?manage=` names; unknown
 * kinds render an explicit error instead of an empty dialog.
 */
export interface ManagementRequest {
  kind: ManagementKind | (string & {});
  feed?: FeedDTO;
  group?: GroupDTO;
  view?: ReaderView;
  /** Hot link to blacklist (kind "blacklist"); its URL prefills a new rule. */
  link?: Pick<HotLinkDTO, "url"> & Partial<HotLinkDTO>;
  /** Initial maintenance operation (kind "maintenance"). */
  operation?: MaintenanceOperation;
  /** Initial preferences tab (kind "preferences"). */
  tab?: PreferenceTab;
}

export interface ManagementDialogProps {
  request: ManagementRequest;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

export interface ManagementPanelProps extends ManagementDialogProps {
  /** Rendered in a page instead of a modal: no overlay or focus trap. */
  standalone?: boolean;
}

export function isManagementKind(kind: string): kind is ManagementKind {
  return (MANAGEMENT_KINDS as readonly string[]).includes(kind);
}

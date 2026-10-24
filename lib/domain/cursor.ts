import { createHash } from "node:crypto";
import type { ViewState } from "../contracts";
import { DomainError, integer, object } from "../validation";

export interface ItemCursor {
  version: 1;
  scope: string;
  snapshotId: number;
  publishedAt: number;
  id: number;
  page: number;
}

/** The scope binds a cursor to its filters, owner, and order; it is not an authorization token. */
export function cursorScope(ownerId: number, view: ViewState, sortOrder: number): string {
  return createHash("sha256").update(JSON.stringify([
    ownerId, view.section, view.groupId, view.showFeeds ? view.feedId : 0,
    view.search, view.showRead, sortOrder,
  ])).digest("hex");
}

export function decodeCursor(value: unknown, expectedScope: string): ItemCursor {
  try {
    if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const row = object(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (row.version !== 1 || row.scope !== expectedScope) throw new Error();
    return {
      version: 1, scope: expectedScope,
      snapshotId: integer(row.snapshotId, "snapshotId"),
      publishedAt: integer(row.publishedAt, "publishedAt"),
      id: integer(row.id, "id", 1),
      page: integer(row.page, "page", 1, 1000000),
    };
  } catch {
    throw new DomainError("This page cursor is invalid for the current view. Reload the first page.", "INVALID_CURSOR", 400);
  }
}

export function encodeCursor(value: Omit<ItemCursor, "version">): string {
  return Buffer.from(JSON.stringify({ version: 1, ...value })).toString("base64url");
}

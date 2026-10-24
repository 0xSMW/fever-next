import { createDefaultPreferences, createDefaultViewState } from "../config";
import { bytes, MappingError, text, uint, type MappedRow } from "./transform";
import { utf8 } from "./php";
import type { SnapshotRow } from "./types";

/** Starter imports use a separate empty target and preserve their own integer namespace. */
export function mapStarterRow(row: SnapshotRow): MappedRow {
  const timestamp = (field: string): number => {
    const raw = text(row, field)!;
    // Prisma SQLite DateTime uses milliseconds; exported SQL text may use ISO-8601.
    const milliseconds = /^\d+$/.test(raw) ? Number(raw) : /^\d{4}-\d\d-\d\d[T ]/.test(raw) ? Date.parse(raw.endsWith("Z") || /[+-]\d\d:\d\d$/.test(raw) ? raw : raw.replace(" ", "T") + "Z") : NaN;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds % 1000 !== 0) throw new MappingError("STARTER_DATE_PRECISION", field, "Timestamp is invalid or loses milliseconds in the epoch-second target; retain in quarantine for an explicit decision");
    return milliseconds / 1000;
  };
  const display = { itemExcerpts: -1, itemAllows: -1, unreadCounts: -1, sortOrder: -1 };
  if (row.table === "User") {
    const id = uint(row, "id", 1);
    if (id !== 1) throw new MappingError("STARTER_OWNER_ID", "id", "The starter owner ID needs an explicit owner mapping to the singleton target");
    const emailBytes = bytes(row.fields.email, "email"); const email = utf8(emailBytes); const password = bytes(row.fields.password, "password");
    if (!email.includes("@") || emailBytes.length > 320 || /[\u0000-\u001f\u007f]/.test(email) || password.length > 4096) throw new MappingError("INVALID_CREDENTIAL", "User", "Starter credentials are outside supported bounds");
    utf8(password);
    return { kind: "config", id, email, emailBytes, password, version: 139, preferences: createDefaultPreferences(), view: createDefaultViewState(), installedAt: timestamp("createdAt"), lastViewedAt: 0, lastSessionAt: 0, unknownKeys: [] };
  }
  if (row.table === "Group") return { kind: "group", id: uint(row, "id", 1), title: text(row, "name")!, ...display };
  if (row.table === "Feed") {
    const owner = text(row, "userId", true);
    if (owner !== "1") throw new MappingError("STARTER_OWNER_AMBIGUITY", "userId", "Unowned or differently owned starter feed needs an explicit ownership decision");
    return { kind: "feed", id: uint(row, "id", 1), faviconId: 0, title: text(row, "title", true), url: text(row, "url")!, siteUrl: text(row, "siteUrl", true), domain: null, checksum: 0, requiresAuth: false, credential: null, isSpark: false, preventsHotlinking: false, ...display, lastRefreshedAt: 0, lastUpdatedAt: 0, lastAddedAt: 0 };
  }
  if (row.table === "Item") {
    const read = uint(row, "read");
    if (read > 1) throw new MappingError("INVALID_FLAG", "read", "Invalid starter read flag");
    return { kind: "item", id: uint(row, "id", 1), feedId: uint(row, "feedId", 1), uid: `starter:${uint(row, "id", 1)}`, title: text(row, "title")!, author: null, rawHtml: text(row, "content", true), url: text(row, "link")!, checksum: 0, readAt: read, isSaved: false, publishedAt: timestamp("pubDate"), addedAt: timestamp("createdAt") };
  }
  throw new MappingError("UNSUPPORTED_TABLE", "", "Unknown starter table");
}

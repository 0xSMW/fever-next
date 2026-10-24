import "server-only";
import type { Metadata } from "next";
import { getDb } from "@/lib/db/client";
import { readerPreferences } from "@/lib/db/schema";

/**
 * The source login page advertised the Saved Items RSS feed only when the
 * owner enabled publishing (help-saved-feed: "discoverable from your Fever
 * login screen"). This reads the single owner's flag; any failure, including
 * an uninstalled or unreachable database, means "not published".
 */
export async function savedRssMetadata(): Promise<Metadata["alternates"] | undefined> {
  try {
    const [row] = await getDb().select({ share: readerPreferences.share }).from(readerPreferences).limit(1);
    if (!row?.share) return undefined;
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    return { types: { "application/rss+xml": [{ url: `${basePath}/rss/saved`, title: "Saved Items" }] } };
  } catch {
    return undefined;
  }
}

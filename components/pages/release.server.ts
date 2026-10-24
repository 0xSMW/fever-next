import "server-only";
import { eq } from "drizzle-orm";
import packageJson from "@/package.json";
import { SCHEMA_VERSION } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { installation } from "@/lib/db/schema";

export interface ReleaseInfo {
  appVersion: string;
  expectedSchema: number;
  databaseSchema: number | null;
  status: string | null;
  installedAt: number | null;
  updatedAt: string | null;
  error: string | null;
}

/** Local release status only. There is no remote update check (the vendor service is gone). */
export async function getReleaseInfo(): Promise<ReleaseInfo> {
  const base = { appVersion: String(packageJson.version ?? "unknown"), expectedSchema: SCHEMA_VERSION };
  try {
    const [row] = await getDb()
      .select({ schemaVersion: installation.schemaVersion, status: installation.status, installedAt: installation.installedAt, updatedAt: installation.updatedAt })
      .from(installation)
      .where(eq(installation.id, 1))
      .limit(1);
    if (!row) return { ...base, databaseSchema: null, status: null, installedAt: null, updatedAt: null, error: "No installation record was found." };
    const updated = row.updatedAt as unknown;
    return {
      ...base,
      databaseSchema: Number(row.schemaVersion),
      status: row.status,
      installedAt: Number(row.installedAt) || null,
      updatedAt: updated instanceof Date ? updated.toISOString() : typeof updated === "string" ? updated : null,
      error: null,
    };
  } catch {
    return { ...base, databaseSchema: null, status: null, installedAt: null, updatedAt: null, error: "The installation record could not be read." };
  }
}

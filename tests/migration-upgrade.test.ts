import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { SCHEMA_VERSION } from "../lib/config";
import { items } from "../lib/db/schema";
import { assertRestoredHistory, reviewedRestoreHistory } from "../cli/postgres-tools";

test("schema2 preserves the applied initial migration and adds the exact navigation index", async () => {
  assert.equal(SCHEMA_VERSION, 2);
  const initial = await readFile(new URL("../migrations/0000_initial.sql", import.meta.url));
  assert.equal(createHash("sha256").update(initial).digest("hex"), "36f21f4640973d69d104f8ae8797154d65e7bd2cc51403324fb493e7c5b06542");
  const reviewed = await reviewedRestoreHistory(SCHEMA_VERSION);
  assert.deepEqual(reviewed.map(({ version, file }) => ({ version, file })), [
    { version: 1, file: "0000_initial.sql" }, { version: 2, file: "0001_items_feed_navigation.sql" },
  ]);
  const sql = await readFile(new URL("../migrations/0001_items_feed_navigation.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE INDEX items_feed_navigation_idx ON items \(feed_id, read_at, is_saved\);/);
  assert.doesNotMatch(sql, /CONCURRENTLY|DROP|DELETE|UPDATE/i);
  const index = getTableConfig(items).indexes.find(({ config }) => config.name === "items_feed_navigation_idx")!;
  assert.ok(index);
  assert.equal(index.config.method, "btree");
  assert.deepEqual(index.config.columns.map(column => "name" in column ? column.name : null), ["feed_id", "read_at", "is_saved"]);
  const journal = JSON.parse(await readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"));
  assert.deepEqual(journal.entries.map(({ idx, tag }: { idx: number; tag: string }) => ({ idx, tag })), [
    { idx: 0, tag: "0000_initial" }, { idx: 1, tag: "0001_items_feed_navigation" },
  ]);
});

test("restore accepts known reviewed schema prefixes and rejects unknown or future versions", async () => {
  for (const version of [1, 2]) {
    const reviewed = await reviewedRestoreHistory(version);
    assert.equal(reviewed.length, version);
    assertRestoredHistory(version, [{ schema_version: version }], reviewed.map(({ version, file, sha256 }) => ({ version, filename: file, sha256 })), reviewed);
  }
  for (const version of [0, -1, 1.5, 3, NaN, Infinity]) await assert.rejects(reviewedRestoreHistory(version), /not supported/);
});

test("restored installation and migration history must exactly match the approved archive schema", async () => {
  const reviewed = await reviewedRestoreHistory(1);
  const applied = reviewed.map(({ version, file, sha256 }) => ({ version, filename: file, sha256 }));
  for (const installation of [[], [{ schema_version: 2 }], [{ schema_version: 1 }, { schema_version: 1 }]]) {
    assert.throws(() => assertRestoredHistory(1, installation, applied, reviewed), /does not match/);
  }
  for (const history of [[], [...applied, ...applied], [{ ...applied[0], sha256: "0".repeat(64) }], [{ ...applied[0], filename: "0000_other.sql" }], [{ ...applied[0], version: 2 }]]) {
    assert.throws(() => assertRestoredHistory(1, [{ schema_version: 1 }], history, reviewed), /does not match|diverges/);
  }
});

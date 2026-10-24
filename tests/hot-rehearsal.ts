import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { getPool } from "../lib/db/client";
import { assertSchema, assertTarget, connectTarget, targetFingerprint } from "../lib/migration/target";

export const hotEndpoint = "ep-gentle-brook-artugvdd.c-4.us-west-2.aws.neon.tech";
export const hotFingerprint = "48201cdbaaf3d3211e57ee5d9b6147e91685641b1f91084962392509bd950729";
export const mysqlDatabase = "fever_hot_parity_20261024";
export const hotEnabled = process.env.FEVER_HOT_TESTS === "1";
const evidenceDirectory = resolve(process.env.FEVER_TEST_EVIDENCE_DIR ?? "tests/.artifacts/hot");

export function receipt(name: string, value: unknown) {
  assert.match(name, /^[a-z0-9-]+\.json$/);
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(resolve(evidenceDirectory, name), JSON.stringify(value, null, 2) + "\n");
}

export async function connectRehearsal() {
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, hotEndpoint, "Refusing any other Neon branch");
  const socketPath = process.env.FEVER_MYSQL_SOCKET!;
  assert.match(socketPath, /^\/private\/tmp\/fever-migration-rehearsal-20261024-[A-Za-z0-9]+\/mysql\.sock$/);
  const operator = await connectTarget(process.env.DATABASE_URL!);
  try {
    await assertTarget(operator, process.env.DATABASE_URL!, hotFingerprint);
    await assertSchema(operator);
    const source = await mysql.createConnection({ socketPath, user: "root", charset: "utf8mb4", supportBigNumbers: true, bigNumberStrings: true });
    try {
      const [metadata] = await source.query<mysql.RowDataPacket[]>("SELECT @@version AS version, @@datadir AS datadir");
      assert.equal(metadata[0].version, "5.7.24");
      assert.equal(metadata[0].datadir, socketPath.replace(/mysql\.sock$/, "mysql-data/"));
      await source.query("CREATE DATABASE IF NOT EXISTS fever_hot_parity_20261024 CHARACTER SET utf8 COLLATE utf8_unicode_ci");
      await source.query("USE fever_hot_parity_20261024");
      assert.equal((await source.query<mysql.RowDataPacket[]>("SELECT DATABASE() AS name"))[0][0].name, mysqlDatabase);
      return { source, operator, pool: getPool(), identity: await targetFingerprint(operator, process.env.DATABASE_URL!) };
    } catch (error) { await source.end(); throw error; }
  } catch (error) { await operator.end(); throw error; }
}

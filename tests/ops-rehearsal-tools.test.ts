import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { pgEnvironment } from "../cli/postgres-tools";

const url = "postgresql://fixture_user:fixture%40password@database.example.test/fixture_db";
const keys = ["FEVER_DB_SSL", "FEVER_DB_SSL_CA", "FEVER_PG_SSL_ROOT_CERT", "FEVER_BASE_URL", "NEXTAUTH_URL", "NEXT_PUBLIC_BASE_PATH"] as const;
function environment(t: TestContext, values: Partial<Record<typeof keys[number], string>>) {
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => { for (const key of keys) { const value = original[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test("PostgreSQL18 operator TLS uses system roots and keeps credentials in child environment", t => {
  environment(t, { FEVER_DB_SSL: "true" });
  const child = pgEnvironment(url);
  assert.equal(child.PGSSLMODE, "verify-full");
  assert.equal(child.PGSSLROOTCERT, "system");
  assert.equal(child.PGUSER, "fixture_user");
  assert.equal(child.PGPASSWORD, "fixture@password");
  assert.equal(child.PGDATABASE, "fixture_db");
  assert.equal(child.PGHOST, "database.example.test");
  assert.equal(child.DATABASE_URL, undefined);
});

test("operator TLS honors an explicit root certificate and requires one for a custom CA", t => {
  environment(t, { FEVER_DB_SSL: "true", FEVER_DB_SSL_CA: "fixture-custom-ca" });
  assert.throws(() => pgEnvironment(url), /FEVER_PG_SSL_ROOT_CERT/);
  process.env.FEVER_PG_SSL_ROOT_CERT = "/private/fixture/root.pem";
  assert.equal(pgEnvironment(url).PGSSLROOTCERT, "/private/fixture/root.pem");
});

test("explicit local plaintext does not inherit a root certificate or unsafe libpq settings", t => {
  environment(t, { FEVER_DB_SSL: "false", FEVER_PG_SSL_ROOT_CERT: "/unused/root.pem" });
  const previousOptions = process.env.PGOPTIONS;
  process.env.PGOPTIONS = "-c search_path=untrusted";
  t.after(() => { if (previousOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = previousOptions; });
  const child = pgEnvironment(url);
  assert.equal(child.PGSSLMODE, "disable");
  assert.equal(child.PGSSLROOTCERT, undefined);
  assert.equal(child.PGOPTIONS, undefined);
});

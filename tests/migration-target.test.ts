import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Client } from "pg";
import { closeTarget, connectTarget } from "../lib/migration/target";

const fixtureUrl = "postgresql://fixture-user:fixture-password@127.0.0.1/fixture";

test("target handshake failure closes its client without issuing session SQL", async () => {
  const failure = new Error("Fixture handshake failed");
  let cleanupCompleted = false;
  const connect = mock.method(Client.prototype, "connect", async () => { throw failure; });
  const query = mock.method(Client.prototype, "query", async () => { throw new Error("Session SQL must not run"); });
  const end = mock.method(Client.prototype, "end", async () => { await new Promise<void>(resolve => setImmediate(resolve)); cleanupCompleted = true; });
  try {
    await assert.rejects(() => connectTarget(fixtureUrl), error => error === failure);
    assert.equal(connect.mock.callCount(), 1);
    assert.equal(query.mock.callCount(), 0);
    assert.equal(end.mock.callCount(), 1);
    assert.equal(end.mock.calls[0].this, connect.mock.calls[0].this);
    assert.equal(cleanupCompleted, true, "connection rejection must wait for socket cleanup");
  } finally { mock.restoreAll(); }
});

test("target session initialization failure closes the successfully connected client", async () => {
  const failure = new Error("Fixture search_path failed");
  const connect = mock.method(Client.prototype, "connect", async () => {});
  const query = mock.method(Client.prototype, "query", async () => { throw failure; });
  const end = mock.method(Client.prototype, "end", async () => {});
  try {
    await assert.rejects(() => connectTarget(fixtureUrl), error => error === failure);
    assert.equal(connect.mock.callCount(), 1);
    assert.deepEqual(query.mock.calls[0].arguments, ["SET search_path TO public, pg_catalog"]);
    assert.equal(end.mock.callCount(), 1);
    assert.equal(end.mock.calls[0].this, connect.mock.calls[0].this);
  } finally { mock.restoreAll(); }
});

test("target cleanup errors preserve the original connection error", async () => {
  const failure = new Error("Fixture original failure");
  mock.method(Client.prototype, "connect", async () => { throw failure; });
  const end = mock.method(Client.prototype, "end", async () => { throw new Error("Fixture cleanup failed"); });
  try {
    await assert.rejects(() => connectTarget(fixtureUrl), error => error === failure);
    assert.equal(end.mock.callCount(), 1);
  } finally { mock.restoreAll(); }
});

test("successful target initialization returns the open client for its caller to own", async () => {
  const connect = mock.method(Client.prototype, "connect", async () => {});
  const query = mock.method(Client.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  const end = mock.method(Client.prototype, "end", async () => {});
  try {
    const client = await connectTarget(fixtureUrl);
    assert.equal(client, connect.mock.calls[0].this);
    assert.deepEqual(query.mock.calls[0].arguments, ["SET search_path TO public, pg_catalog"]);
    assert.equal(end.mock.callCount(), 0);
    assert.doesNotThrow(() => client.emit("error", new Error("Fixture idle transport error")));
  } finally { mock.restoreAll(); }
});

function closingFixture(status: "I" | "T" | "E" | null = "I") {
  let ended = 0; let destroyed = 0;
  const fixture = { getTransactionStatus: () => status, _getActiveQuery: (): unknown => null, _queryQueue: [] as unknown[], _sentQueryQueue: [] as unknown[],
    end: async () => { ended++; }, connection: { stream: { destroy: () => { destroyed++; } } } };
  return { fixture, client: fixture as unknown as Client, counts: () => ({ ended, destroyed }) };
}

test("idle operator shutdown preserves graceful close without destroying its socket", async () => {
  const fixture = closingFixture();
  await closeTarget(fixture.client, 10);
  assert.deepEqual(fixture.counts(), { ended: 1, destroyed: 0 });
});

test("idle operator shutdown bounds a missing end event and consumes late rejection", async () => {
  const fixture = closingFixture(); let rejectEnd: (error: Error) => void = () => {};
  fixture.fixture.end = () => new Promise<void>((_resolve, reject) => { rejectEnd = reject; });
  await closeTarget(fixture.client, 5);
  assert.equal(fixture.counts().destroyed, 1);
  rejectEnd(new Error("late socket failure"));
  await new Promise<void>(resolve => setImmediate(resolve));
});

test("operator shutdown refuses active transactions and in-flight or queued queries", async () => {
  for (const status of ["T", "E"] as const) {
    const fixture = closingFixture(status);
    await assert.rejects(() => closeTarget(fixture.client, 5), /transaction/);
    assert.deepEqual(fixture.counts(), { ended: 0, destroyed: 0 });
  }
  for (const state of ["active", "queued", "sent"]) {
    const fixture = closingFixture();
    if (state === "active") fixture.fixture._getActiveQuery = () => ({});
    if (state === "queued") fixture.fixture._queryQueue.push({});
    if (state === "sent") fixture.fixture._sentQueryQueue.push({});
    await assert.rejects(() => closeTarget(fixture.client, 5), /queries/);
    assert.deepEqual(fixture.counts(), { ended: 0, destroyed: 0 });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import { encode } from "next-auth/jwt";
import { Pool } from "pg";
import { getAuthRuntime } from "../lib/auth/runtime";
import { issueCsrfToken } from "../lib/auth/security";
import { closeDatabase } from "../lib/db/client";
import { POST } from "../app/api/commands/route";

const require = createRequire(import.meta.url);

// Fresh processes keep module-cache assertions independent of this file's imports.
function isolated(work: string) {
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import pg from 'pg';
    const require=createRequire(import.meta.url);
    let attempts=0;
    for(const prototype of [pg.Pool.prototype,pg.Client.prototype]) {
      prototype.query=prototype.connect=()=>{attempts++;throw Error('DATABASE_FORBIDDEN');};
    }
    const loaded=()=>Object.keys(require.cache).filter(path=>path.includes('/lib/')).map(path=>path.slice(path.lastIndexOf('/lib/')+1));
    const owner={id:1,email:'command-loading@example.test'};
    ${work}
    assert.equal(attempts,0,'No real PostgreSQL connection/query is permitted');
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("command route import and read/save no-op dispatch avoid unrelated modules", () => {
  isolated(`
    await import('./app/api/commands/route.ts');
    const {executeDomainCommand}=await import('./lib/domain/commands.ts');
    for(const action of ['items.read','items.unread','items.save','items.unsave']) {
      assert.deepEqual(await executeDomainCommand(owner,action,{ids:[]}),{changed:0,operationId:null});
      await assert.rejects(executeDomainCommand(owner,action,{ids:[0]}),error=>error.code==='INVALID_INPUT'&&error.fields.ids==='Invalid integer.');
      await assert.rejects(executeDomainCommand(owner,action,{ids:[],extra:true}),error=>error.code==='INVALID_INPUT'&&error.fields.extra==='This field is not supported.');
    }
    await assert.rejects(executeDomainCommand(owner,'items.undo',{operationId:0}),error=>error.code==='INVALID_INPUT');
    await assert.rejects(executeDomainCommand(owner,'scope.read',{scope:'invalid',before:0}),error=>error.code==='INVALID_INPUT');
    await assert.rejects(executeDomainCommand(owner,'unknown',{}),error=>error.code==='UNSUPPORTED_COMMAND'&&error.status===400);
    await assert.rejects(executeDomainCommand(owner,'blacklist.save',{rules:12}),error=>error.code==='INVALID_INPUT');
    const modules=loaded();
    for(const excluded of ['domain/index.ts','domain/reader.ts','domain/hot.ts','domain/subscriptions.ts','domain/blacklist.ts','db/collation.ts','db/uca400-data.ts','maintenance/index.ts','jobs/index.ts','ingest/index.ts','ingest/parser.ts']) {
      assert.ok(!modules.includes('lib/'+excluded),excluded+' eagerly loaded');
    }
    assert.ok(modules.includes('lib/domain/state.ts'));
  `);
});

test("subscription commands load their implementation and preserve input validation", () => {
  isolated(`
    const {executeDomainCommand}=await import('./lib/domain/commands.ts');
    assert.ok(!loaded().includes('lib/domain/subscriptions.ts'));
    await assert.rejects(executeDomainCommand(owner,'feed.create',{url:'invalid'}),error=>error.code==='INVALID_INPUT'&&error.fields.url==='Invalid URL.');
    await assert.rejects(executeDomainCommand(owner,'group.create',{title:''}),error=>error.code==='INVALID_INPUT'&&error.fields.title==='Invalid text.');
    assert.ok(loaded().includes('lib/domain/subscriptions.ts'));
    assert.ok(loaded().includes('lib/db/uca400-data.ts'));
    assert.ok(!loaded().includes('lib/domain/reader.ts'));
    assert.ok(!loaded().includes('lib/domain/blacklist.ts'));
  `);
});

test("blacklist commands lazily compile and retain the public 422 fields contract", () => {
  isolated(`
    const {executeDomainCommand}=await import('./lib/domain/commands.ts');
    assert.ok(!loaded().includes('lib/domain/blacklist.ts'));
    await assert.rejects(executeDomainCommand(owner,'blacklist.save',{rules:'#['}),error=>error.code==='INVALID_BLACKLIST'&&error.status===422&&typeof error.fields.rules==='string');
    assert.ok(loaded().includes('lib/domain/blacklist.ts'));
    assert.ok(!loaded().includes('lib/domain/subscriptions.ts'));
    assert.ok(!loaded().includes('lib/db/uca400-data.ts'));
    assert.ok(!loaded().includes('lib/domain/reader.ts'));
  `);
});

test("the existing domain barrel keeps the same command dispatcher export", () => {
  isolated(`
    const direct=await import('./lib/domain/commands.ts');
    const barrel=await import('./lib/domain/index.ts');
    assert.equal(barrel.executeDomainCommand,direct.executeDomainCommand);
    for(const name of ['getReaderView','getItem','getNavigation','getPreferences','getViewState','resolveDisplayOptions','mutateItems','markScopeRead','undoRecentlyRead','undoOperation','createFeed','updateFeed','createGroup','updateGroup']) {
      assert.equal(typeof barrel[name],'function',name+' barrel export missing');
    }
  `);
});

test("command HTTP boundary preserves authentication, CSRF and body/action validation order", async t => {
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: "postgresql://unused:unused@127.0.0.1/unused_command_loading",
    FEVER_BASE_URL: "https://command-loading.example.test", NEXT_PUBLIC_BASE_PATH: "",
    NEXTAUTH_URL: "https://command-loading.example.test/api/auth",
    NEXTAUTH_SECRET: "command-loading-test-only-secret-01234567890123456789",
  });
  let authQueries = 0;
  t.mock.method(Pool.prototype, "query", async () => {
    authQueries++;
    return { rows: [[1, "command-loading@example.test", 1]], rowCount: 1 };
  });
  const runtime = getAuthRuntime();
  const owner = { id: 1, email: "command-loading@example.test", authEpoch: 1 };
  const jwt = await encode({ secret: runtime.secret, token: {
    sub: "1", email: owner.email, authEpoch: 1, installationUrl: runtime.baseUrl,
    authenticatedUntil: Math.floor(Date.now() / 1000) + 300,
  } });
  const sessionCookie = `${runtime.sessionCookieName}=${jwt}`;
  const token = issueCsrfToken(new Request(`${runtime.baseUrl}/api/session`), owner).token;
  const makeRequest = (body: string, authenticated: boolean, csrf: boolean) => new Request(`${runtime.baseUrl}/api/commands`, {
    method: "POST", headers: {
      "Content-Type": "application/json", Origin: runtime.origin,
      ...(authenticated ? { Cookie: `${sessionCookie}; ${runtime.csrfCookieName}=${token}` } : {}),
      ...(csrf ? { "X-Fever-CSRF": token } : {}),
    }, body,
  });
  try {
    const anonymous = await POST(makeRequest("{", false, false));
    assert.equal(anonymous.status, 401);
    assert.equal(authQueries, 0, "Unauthenticated malformed body must not be parsed or query PostgreSQL");
    const missingCsrf = await POST(makeRequest("{", true, false));
    assert.equal(missingCsrf.status, 403);
    const malformed = await POST(makeRequest("{", true, true));
    assert.equal(malformed.status, 400);
    for (const [body, code] of [
      [{ action: 12, payload: {} }, "INVALID_REQUEST"],
      [{ action: "items.read", payload: [] }, "INVALID_REQUEST"],
      [{ action: "not-supported", payload: {} }, "UNKNOWN_COMMAND"],
    ] as const) {
      const response = await POST(makeRequest(JSON.stringify(body), true, true));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, code);
    }
    const noOp = await POST(makeRequest(JSON.stringify({ action: "items.save", payload: { ids: [] } }), true, true));
    assert.equal(noOp.status, 200);
    assert.deepEqual(await noOp.json(), { ok: true, changed: 0, operationId: null });
    assert.ok(!Object.keys(require.cache).some(path => path.endsWith("/lib/jobs/index.ts")));
    assert.ok(!Object.keys(require.cache).some(path => path.endsWith("/lib/maintenance/index.ts")));
    assert.equal(authQueries, 6, "Only the mocked authentication SELECT runs for authenticated requests");
  } finally { await closeDatabase(); }
});

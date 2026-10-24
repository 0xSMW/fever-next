import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from 'next-auth/jwt';
import { Pool } from 'pg';
import { getCheckedSessionEpoch, getOwner } from '../lib/auth/owner';
import { getAuthRuntime } from '../lib/auth/runtime';
import { closeDatabase, getDb } from '../lib/db/client';
import { beginDomainMutation } from '../lib/domain/guard';
import { DomainError } from '../lib/validation';

Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1/unused_auth_fixture',
  FEVER_BASE_URL: 'https://reader.example/fever', NEXT_PUBLIC_BASE_PATH: '/fever',
  NEXTAUTH_URL: 'https://reader.example/fever/api/auth',
  NEXTAUTH_SECRET: 'test-only-independent-secret-material-0123456789',
});

test('domain writes retain the checked browser epoch and lock authorization until transaction completion', async t => {
  const email = 'Owner@example.com';
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let epoch = 4;
  let recoveryRequired = false;
  let installationStatus = 'ready';
  // Intercept the PostgreSQL transport, leaving JWT verification, context creation,
  // Drizzle predicate compilation and the domain guard itself unchanged.
  t.mock.method(Pool.prototype, 'query', async (...args: unknown[]) => {
    const query = args[0] as { text: string; values?: unknown[] };
    const text = query.text;
    const values = (args[1] ?? query.values ?? []) as unknown[];
    statements.push({ text, values });
    if (text.includes('pg_advisory_xact_lock_shared')) return { rows: [], rowCount: 1 };
    if (text.startsWith('select "status"')) return { rows: [[installationStatus]], rowCount: 1 };
    assert.match(text, /from "owner"/);
    const epochParameter = /"owner"\."auth_epoch" = \$(\d+)/.exec(text);
    const requiresRecoveryClear = /"owner"\."recovery_required" = \$(\d+)/.exec(text);
    const accepted = (!epochParameter || values[Number(epochParameter[1]) - 1] === epoch) &&
      (!requiresRecoveryClear || values[Number(requiresRecoveryClear[1]) - 1] === recoveryRequired);
    const rows = !accepted ? [] : text.startsWith('select "owner"."id", "owner"."email"') ? [[1, email, epoch]] : [[1]];
    return { rows, rowCount: rows.length };
  });
  try {
    const runtime = getAuthRuntime();
    const token = await encode({ secret: runtime.secret, token: {
      sub: '1', email, authEpoch: epoch, authenticatedUntil: Math.floor(Date.now() / 1000) + 300,
      installationUrl: runtime.baseUrl,
    } });
    const owner = await getOwner(new Request(`${runtime.baseUrl}/`, { headers: { cookie: `${runtime.sessionCookieName}=${token}` } }));
    assert.ok(owner);
    assert.deepEqual(owner, { id: 1, email });
    assert.equal(getCheckedSessionEpoch(owner), 4);
    await beginDomainMutation(getDb(), owner);
    const guardLookup = statements.at(-1)!;
    assert.match(guardLookup.text, /for share$/i);
    assert.match(guardLookup.text, /"owner"\."auth_epoch" = \$/);
    assert.match(guardLookup.text, /"owner"\."recovery_required" = \$/);
    assert.match(statements.at(-3)!.text, /pg_advisory_xact_lock_shared/);

    await beginDomainMutation(getDb(), owner, { readOnly: true });
    const readLookup = statements.at(-1)!;
    assert.doesNotMatch(readLookup.text, /for share/i);
    assert.match(readLookup.text, /"owner"\."auth_epoch" = \$/);
    assert.match(readLookup.text, /"owner"\."recovery_required" = \$/);

    // Simulate logout-all committing after HTTP authentication, before domain entry.
    epoch += 1;
    await assert.rejects(beginDomainMutation(getDb(), owner), error => error instanceof DomainError && error.status === 401);
    await assert.rejects(beginDomainMutation(getDb(), owner, { readOnly: true }), error => error instanceof DomainError && error.status === 401);
    const apiOwner = { id: 1, email };
    assert.equal(getCheckedSessionEpoch(apiOwner), undefined);
    await assert.doesNotReject(beginDomainMutation(getDb(), apiOwner));
    assert.doesNotMatch(statements.at(-1)!.text, /"owner"\."auth_epoch" = \$/);

    recoveryRequired = true;
    await assert.rejects(beginDomainMutation(getDb(), apiOwner), error => error instanceof DomainError && error.status === 401);
    installationStatus = 'maintenance';
    await assert.rejects(beginDomainMutation(getDb(), apiOwner), error => error instanceof DomainError && error.code === 'MAINTENANCE');
  } finally { await closeDatabase(); }
});

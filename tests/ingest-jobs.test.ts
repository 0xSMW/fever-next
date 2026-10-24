import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueInstallationRefresh, enqueueScheduledRefresh, enqueueRefresh, cancelRefresh, getRefreshJob, jobDTO } from '../lib/jobs';
import { Pool, type PoolClient } from 'pg';
import { encode } from 'next-auth/jwt';
import { getOwner, getCheckedSessionEpoch } from '../lib/auth/owner';
import { getAuthRuntime } from '../lib/auth/runtime';
import { closeDatabase } from '../lib/db/client';
import { assertLease, newWorkerId } from '../lib/jobs/worker';
import { JobError, LostLeaseError, type FeedLease, type InstallationContext, type JobLease } from '../lib/jobs/types';

test('job DTO converts PostgreSQL numeric strings and timestamps without dropping nulls', () => {
  assert.deepEqual(jobDTO({ id: '12', status: 'running', total_feeds: '5', completed_feeds: '2', current_feed_id: '8', current_feed_title: 'Feed', error: null, created_at: new Date('2025-01-01T00:00:00.999Z'), started_at: '2025-01-01T00:00:01Z', finished_at: null }), {
    id: 12, status: 'running', totalFeeds: 5, completedFeeds: 2, currentFeedId: 8, currentFeedTitle: 'Feed', error: null, createdAt: 1735689600, startedAt: 1735689601, finishedAt: null,
  });
  assert.throws(() => jobDTO({ id: '9007199254740993' }), /safe|range|identifier/i);
});

test('invalid installation contexts reject before reaching the database', async () => {
  const context = { installationId: 2, ownerId: 1 } as unknown as InstallationContext;
  const invalid = (error: unknown) => error instanceof JobError && error.code === 'INVALID_INSTALLATION';
  await assert.rejects(enqueueInstallationRefresh(context, { scope: 'all' }), invalid);
  await assert.rejects(enqueueScheduledRefresh(context), invalid);
});

test('lost leases have a stable conflict contract and worker identities are unique', () => {
  const error = new LostLeaseError();
  assert.ok(error instanceof JobError);
  assert.equal(error.code, 'LEASE_LOST');
  assert.equal(error.status, 409);
  const first = newWorkerId();
  assert.notEqual(first, newWorkerId());
  assert.ok(first.length > 20);
});

test('lease validation stops on unavailable installation, lost job fence, or changed feed credentials', async () => {
  const job: JobLease = { id: 1, ownerId: 2, workerId: 'fixture-worker', fence: 3, force: false, faviconOnly: false };
  const feed = { feed: { id: 4, url: 'https://example.com/feed' }, fence: 5, credentialCiphertext: 'original-ciphertext' } as FeedLease;
  const client = (results: Array<{ rowCount: number; rows?: Array<Record<string, unknown>> }>) => {
    const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
    return { calls, value: { query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      assert.ok(results.length, 'unexpected query after a failed lease check');
      return { rows: [], ...results.shift() };
    } } as unknown as PoolClient };
  };
  const unavailable = client([{ rowCount: 1 }, { rowCount: 0 }]);
  await assert.rejects(assertLease(unavailable.value, job), (error: unknown) => error instanceof JobError && error.code === 'INSTALLATION_UNAVAILABLE');
  const lost = client([{ rowCount: 1 }, { rowCount: 1 }, { rowCount: 0 }]);
  await assert.rejects(assertLease(lost.value, job), LostLeaseError);
  assert.deepEqual(lost.calls.at(-1)!.values, [1, 2, 'fixture-worker', 3]);
  for (const failureAt of [3, 4, 5]) {
    const results = Array.from({ length: failureAt + 1 }, () => ({ rowCount: 1, rows: [] as Array<Record<string, unknown>> }));
    if (failureAt < 5) results[failureAt].rowCount = 0;
    else results[5].rows = [{ ciphertext: 'replacement-ciphertext' }];
    const changed = client(results);
    await assert.rejects(assertLease(changed.value, job, feed), LostLeaseError);
    assert.equal(changed.calls.length, failureAt + 1);
  }
  const current = client([{ rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1, rows: [{ ciphertext: 'original-ciphertext' }] }]);
  await assertLease(current.value, job, feed);
  assert.deepEqual(current.calls[3].values, [4, 'fixture-worker', 5]);
  assert.deepEqual(current.calls[4].values, [4, 2, 'https://example.com/feed', 'original-ciphertext']);
});

test('job transactions reject browser revocation or recovery between entry authentication and queue work', async t => {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1/unused_job_fixture',
    FEVER_BASE_URL: 'https://reader.example/fever', NEXT_PUBLIC_BASE_PATH: '/fever',
    NEXTAUTH_URL: 'https://reader.example/fever/api/auth',
    NEXTAUTH_SECRET: 'test-only-independent-secret-material-0123456789',
  });
  const email = 'Owner@example.com';
  let epoch = 4;
  let recoveryRequired = false;
  let rotateOnConnect = false;
  let recoverOnConnect = false;
  const statements: Array<{ text: string; values: unknown[] }> = [];
  t.mock.method(Pool.prototype, 'query', async (...args: unknown[]) => {
    const query = args[0] as { text: string; values?: unknown[] };
    const values = (args[1] ?? query.values ?? []) as unknown[];
    const expectedEpoch = /"owner"\."auth_epoch" = \$(\d+)/.exec(query.text);
    const accepted = !recoveryRequired && (!expectedEpoch || values[Number(expectedEpoch[1]) - 1] === epoch);
    const rows = !accepted ? [] : query.text.startsWith('select "owner"."id", "owner"."email"') ? [[1, email, epoch]] : [[1]];
    return { rows, rowCount: rows.length };
  });
  t.mock.method(Pool.prototype, 'connect', async () => {
    if (rotateOnConnect) { epoch++; rotateOnConnect = false; }
    if (recoverOnConnect) { recoveryRequired = true; recoverOnConnect = false; }
    return {
      query: async (text: string, values: unknown[] = []) => {
        statements.push({ text, values });
        if (/^SELECT 1 FROM owner WHERE/.test(text)) {
          const accepted = !recoveryRequired && (values[2] === null || values[2] === epoch);
          return { rows: accepted ? [{ id: 1 }] : [], rowCount: accepted ? 1 : 0 };
        }
        if (text.startsWith('SELECT * FROM refresh_jobs')) return { rows: [], rowCount: 0 };
        assert.ok(['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text) || text.includes('pg_advisory_xact_lock_shared') || text.includes('JOIN owner'), `Unexpected queue operation: ${text}`);
        return { rows: [{ id: 1 }], rowCount: 1 };
      },
      release: () => {},
    };
  });
  try {
    const runtime = getAuthRuntime();
    const token = await encode({ secret: runtime.secret, token: { sub: '1', email, authEpoch: 4, authenticatedUntil: Math.floor(Date.now() / 1000) + 300, installationUrl: runtime.baseUrl } });
    const owner = await getOwner(new Request(`${runtime.baseUrl}/`, { headers: { cookie: `${runtime.sessionCookieName}=${token}` } }));
    assert.ok(owner);
    assert.equal(getCheckedSessionEpoch(owner), 4);
    const unauthorized = (error: unknown) => error instanceof JobError && error.code === 'UNAUTHORIZED' && error.status === 401;
    for (const action of [() => enqueueRefresh(owner, { scope: 'all' }), () => cancelRefresh(owner, 1)]) {
      epoch = 4;
      rotateOnConnect = true;
      statements.length = 0;
      await assert.rejects(action(), unauthorized);
      assert.match(statements[1].text, /pg_advisory_xact_lock_shared/);
      assert.match(statements[2].text, /JOIN owner/);
      assert.match(statements[3].text, /recovery_required=false[\s\S]*auth_epoch=\$3[\s\S]*FOR SHARE/);
      assert.deepEqual(statements[3].values, [1, email, 4]);
      assert.equal(statements.at(-1)!.text, 'ROLLBACK');
      assert.equal(statements.length, 5, 'no queue read or write may follow revoked authorization');
    }
    const apiOwner = { id: 1, email };
    statements.length = 0;
    assert.equal(await getRefreshJob(apiOwner), null);
    assert.equal(statements[3].values[2], null, 'explicit API contexts do not acquire a browser epoch');
    recoverOnConnect = true;
    statements.length = 0;
    await assert.rejects(getRefreshJob(apiOwner), unauthorized);
    assert.equal(statements.length, 5);
  } finally { await closeDatabase(); }
});

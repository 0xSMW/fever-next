import type { PoolClient } from 'pg';
import { getPool } from '../db/client';
import { JobError } from './types';
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (attempt >= 2 || !['40001', '40P01'].includes((error as { code?: string }).code ?? '')) throw error;
    } finally { client.release(); }
    await new Promise(resolve => setTimeout(resolve, 30 * 2 ** attempt + Math.floor(Math.random() * 50)));
  }
}
export async function requireReady(client: PoolClient, ownerId: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('fever:installation',0))");
  const ready = await client.query("SELECT 1 FROM installation i JOIN owner o ON o.id=$1 WHERE i.id=1 AND i.status='ready'", [ownerId]);
  if (!ready.rowCount) throw new JobError('INSTALLATION_UNAVAILABLE', 'The installation is not ready for refresh work.', 503);
}

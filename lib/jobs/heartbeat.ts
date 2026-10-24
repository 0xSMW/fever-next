import type { PoolClient } from 'pg';
import { getPool } from '../db/client';
import type { InstallationContext } from './types';

type Session = Pick<PoolClient, 'query'>;
export async function heartbeat(context: InstallationContext, workerId: string, session?: Session): Promise<void> {
  await (session ?? getPool()).query(`INSERT INTO worker_heartbeats(worker_id,owner_id) VALUES($1,$2)
    ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at=clock_timestamp(),stopped_at=NULL`, [workerId, context.ownerId]);
}
export async function stopHeartbeat(workerId: string, session?: Session): Promise<void> {
  await (session ?? getPool()).query('UPDATE worker_heartbeats SET stopped_at=clock_timestamp(),active_job_id=NULL WHERE worker_id=$1', [workerId]);
}

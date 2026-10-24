import type { FeedRow } from '../db/schema';
export interface OwnerContext { id: number; email: string; }
export interface RefreshScope { scope: 'all' | 'group' | 'feed'; id?: number; force?: boolean; faviconOnly?: boolean; }
export interface InstallationContext { ownerId: number; installationId: 1; }
export interface JobLease { id: number; ownerId: number; workerId: string; fence: number; force: boolean; faviconOnly: boolean; }
export interface FeedLease {
  job: JobLease; resultId: number; feed: FeedRow; fence: number; attempts: number;
  etag: string | null; lastModified: string | null; failureCount: number;
  credentialCiphertext: string | null; credentialKeyId: string | null;
  intervalMinutes: number; expirationWeeks: number;
}
export class JobError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = 'JobError'; }
}
export class LostLeaseError extends JobError { constructor() { super('LEASE_LOST', 'The refresh lease was cancelled or replaced.', 409); } }

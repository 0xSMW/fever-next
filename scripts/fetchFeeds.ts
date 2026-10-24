import { pathToFileURL } from 'node:url';
import { closeDatabase } from '../lib/db/client';
import { enqueueInstallationRefresh, installationContext } from '../lib/jobs';
import type { RefreshScope } from '../lib/jobs/types';

/** Operator command: enqueue durable work, then exit. The worker fetches it. */
export async function fetchFeeds(scope: RefreshScope = { scope: 'all' }) {
  return enqueueInstallationRefresh(await installationContext(), scope);
}
export async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const supported = new Set(['--force', '--favicon', '--feed', '--group']);
    let scope: RefreshScope = { scope: 'all', force: args.includes('--force'), faviconOnly: args.includes('--favicon') };
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (!supported.has(arg)) throw new Error('Use --force, --favicon, --feed ID, or --group ID.');
      if (arg === '--feed' || arg === '--group') {
        if (scope.scope !== 'all') throw new Error('Choose only one refresh scope.');
        const value = args[++index];
        if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('The scope ID must be a positive integer.');
        scope = { ...scope, scope: arg === '--feed' ? 'feed' : 'group', id: Number(value) };
      }
    }
    const job = await fetchFeeds(scope);
    console.info(JSON.stringify({ jobId: job.id, status: job.status, totalFeeds: job.totalFeeds }));
  } catch { console.error('Refresh could not be queued. Check the scope, installation status, and database configuration.'); process.exitCode = 1; }
  finally { await closeDatabase(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();

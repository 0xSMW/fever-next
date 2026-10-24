import { timingSafeEqual } from 'node:crypto';
import { BatchConfigurationError, runRefreshBatch, type BatchOptions, type BatchResult } from '../../worker/batch';

/** Authentication completes before any batch dependency can touch the database. */
export function createRefreshHandler(run: (options: BatchOptions) => Promise<BatchResult> = runRefreshBatch, secret: () => string | undefined = () => process.env.CRON_SECRET) {
  return async (request: Request): Promise<Response> => {
    const expected = secret();
    if (!expected) return Response.json({ error: 'Scheduled refresh is not configured.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    const actual = request.headers.get('authorization') ?? '';
    const expectedBytes = Buffer.from(`Bearer ${expected}`);
    const actualBytes = Buffer.from(actual);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    try {
      const result = await run({ signal: request.signal });
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return Response.json({ error: error instanceof BatchConfigurationError ? error.message : 'Scheduled refresh failed.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}

import { createRefreshHandler } from '@/worker/batch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export const GET = createRefreshHandler();

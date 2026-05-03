import { NextRequest, NextResponse } from 'next/server';
import { runDueActions } from '@/lib/workflows';
import { logger } from '@/lib/logger';

/**
 * Vercel cron entry — runs every workspace's due workflow actions.
 *
 * Wired in vercel.json. On Vercel hobby this fires once per day; on
 * Pro, swap to a tighter schedule for sub-day responsiveness. The
 * queue accumulates between runs either way.
 *
 * Authenticates via the Vercel-injected `Authorization: Bearer
 * $CRON_SECRET` header. We don't bypass our normal session middleware
 * for this — instead we accept either:
 *   - a valid CRON_SECRET (production cron)
 *   - localhost requests during dev (no header required)
 *
 * Set CRON_SECRET in Vercel env vars for prod. Without it, the route
 * returns 401 to anonymous traffic so it can't be DOS'd from outside.
 */
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  const isLocal =
    process.env.NODE_ENV !== 'production' &&
    (req.nextUrl.hostname === 'localhost' || req.nextUrl.hostname === '127.0.0.1');

  if (!isLocal) {
    if (!cronSecret) {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
    }
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  // Drain up to 100 due actions across all workspaces in one cron run.
  // Vercel cron invocations have a 300s ceiling on Pro; each action
  // typically takes 1-30s so we have plenty of budget for 100 runs at
  // worst-case durations.
  const startedAt = Date.now();
  logger.info('cron run-workflows: start');
  try {
    const result = await runDueActions({ limit: 100 });
    logger.info('cron run-workflows: done', {
      duration_ms: Date.now() - startedAt,
      ...result,
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.error('cron run-workflows: threw', {
      duration_ms: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'cron failed' }, { status: 500 });
  }
}

// GET also accepted so the route can be probed via browser during dev.
// Same auth gate as POST.
export const GET = POST;

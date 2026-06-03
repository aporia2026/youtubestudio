import { NextRequest, NextResponse } from 'next/server';
import { withCronLock, CRON_LOCK_KEYS } from '@/lib/cron-lock';
import { runShortsAssetDrain } from '@/lib/shorts-asset-cron';
import { logger } from '@/lib/logger';

/**
 * Vercel cron entry for Short style-asset generation (Phase 15.16).
 *
 * Claims queued / in-flight Shorts and advances each through
 * plan → base → variants → done, bounded by a per-tick budget so the
 * function never runs to the 300s ceiling. Work persists incrementally and
 * a lease lets a later tick finish anything this one couldn't — including
 * jobs whose previous tick died. See `src/lib/shorts-asset-cron.ts`.
 *
 * Single-flight via `withCronLock` (its own key, so it never blocks the
 * long-form pipeline cron). Auth mirrors `run-pipeline`: CRON_SECRET in
 * production, localhost bypass for dev testing.
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

  const startedAt = Date.now();
  // Tick id used as the claim owner + log correlation. Date.now()+random is
  // fine here (not a workflow script); it just needs to be unique per tick.
  const tickId = `sa_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
  logger.info('cron run-shorts-assets: start', { tickId });

  const outcome = await withCronLock(CRON_LOCK_KEYS.shortsAssetRunner, async () => {
    return runShortsAssetDrain(tickId);
  });

  if (!outcome.ran) {
    logger.info('cron run-shorts-assets: skipped (another tick in flight)', { tickId });
    return NextResponse.json({ ran: false, reason: 'busy' });
  }

  logger.info('cron run-shorts-assets: done', {
    tickId,
    duration_ms: Date.now() - startedAt,
    ...outcome.result,
  });
  return NextResponse.json({ ran: true, ...outcome.result });
}

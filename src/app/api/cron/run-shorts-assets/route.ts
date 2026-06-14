import { NextRequest, NextResponse } from 'next/server';
import { triggerShortsAssetDrain, pollPendingShortRenders } from '@/lib/shorts-asset-cron';
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
  logger.info('cron run-shorts-assets: start');

  const outcome = await triggerShortsAssetDrain('cron');

  // Finalize any Lambda renders AWS has completed — independent of the
  // asset drain (claims nothing, so it runs even when the drain is busy).
  // This is what lets a render that finished after the user's tab closed
  // get its rendered_video_url written back without a manual poke.
  const renders = await pollPendingShortRenders().catch((err) => {
    logger.warn('cron run-shorts-assets: render-poll failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return { polled: 0, done: 0, errored: 0, reaped: 0 };
  });

  if (!outcome.ran) {
    logger.info('cron run-shorts-assets: drain skipped (another tick in flight)', { renders });
    return NextResponse.json({ ran: false, reason: 'busy', renders });
  }

  logger.info('cron run-shorts-assets: done', {
    duration_ms: Date.now() - startedAt,
    ...outcome.result,
    renders,
  });
  return NextResponse.json({ ran: true, ...outcome.result, renders });
}

// Vercel cron ALWAYS invokes the scheduled path with a GET request
// (https://vercel.com/docs/cron-jobs). A POST-only route returns 405 to
// that GET, so the cron silently never runs. Aliasing GET to the POST
// handler is what actually wires this minute-cron up in production — it
// reads only headers, never a body, so a GET is safe. Same CRON_SECRET
// auth gate applies.
export const GET = POST;

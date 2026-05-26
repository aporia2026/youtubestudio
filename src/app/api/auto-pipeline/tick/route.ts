import { NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { withCronLock, CRON_LOCK_KEYS } from '@/lib/cron-lock';
import { processNextVideo } from '@/lib/auto-pipeline/orchestrator';
import { logger } from '@/lib/logger';

/**
 * POST /api/auto-pipeline/tick
 *
 * User-triggered manual cron drain. Same logic as
 * `/api/cron/run-pipeline` (single-flight via `withCronLock`,
 * `processNextVideo` loop) but gated behind the regular user
 * session instead of `CRON_SECRET` so the UI can kick it without
 * exposing the cron secret to the browser.
 *
 * Why this exists:
 *
 *   - **Local dev**: Vercel cron only fires in production. Without
 *     this endpoint, running `npm run dev` and starting a batch
 *     never advances because nothing triggers the orchestrator.
 *
 *   - **Stuck runs in prod**: occasionally a row sits with a stale
 *     `claimed_at` (handler crashed) or the cron skips a tick. The
 *     "Retry stuck" flow uses this endpoint after clearing zombie
 *     claims so the user doesn't have to wait up to 60s for the
 *     next scheduled tick.
 *
 * Drain budget is small (3 videos per call) because this is the
 * user-pressed-button path, not the every-minute background drain.
 * If a user has a 20-video batch they want to kick, they'll click
 * Retry repeatedly — the lock keeps it safe.
 */

const MANUAL_DRAIN_PER_CALL = 3;

export const POST = apiRoute.authed(async (session) => {
  const startedAt = Date.now();
  logger.info('auto-pipeline manual tick: start', { workspace_id: session.ws });

  try {
    const outcome = await withCronLock(CRON_LOCK_KEYS.pipelineRunner, async () => {
      let advanced = 0;
      let released = 0;
      let noWork = false;
      for (let i = 0; i < MANUAL_DRAIN_PER_CALL; i++) {
        const result = await processNextVideo();
        if (result === 'advanced') advanced++;
        else if (result === 'released') released++;
        else {
          noWork = true;
          break;
        }
      }
      return { advanced, released, drained_to_empty: noWork };
    });

    if (!outcome.ran) {
      logger.info('auto-pipeline manual tick: skipped (cron already running)');
      return NextResponse.json({ ran: false, reason: 'busy' });
    }

    logger.info('auto-pipeline manual tick: done', {
      duration_ms: Date.now() - startedAt,
      ...outcome.result,
    });
    return NextResponse.json({ ran: true, ...outcome.result });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'auto-pipeline: manual tick',
      fallbackMessage: 'Failed to run manual tick.',
    });
  }
});

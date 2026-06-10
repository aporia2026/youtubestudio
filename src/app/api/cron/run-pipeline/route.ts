import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { withCronLock, CRON_LOCK_KEYS } from '@/lib/cron-lock';
import { processNextVideo } from '@/lib/auto-pipeline/orchestrator';
import { logger } from '@/lib/logger';

/**
 * Vercel cron entry for the auto-pipeline.
 *
 * Two responsibilities per tick:
 *
 *   1. **Drain the queue** — claim up to N pending pipeline_run_videos
 *      and advance each by one stage. Bounded so a single tick can't
 *      run past Vercel's 300s ceiling on a stampede. `processNextVideo`
 *      handles the per-row state-machine logic.
 *
 *   2. **Narration-overdue sweep** — flip rows that have been waiting
 *      past their deadline to `narration_overdue`. Cheap UPDATE, runs
 *      before the drain so a stale row that just hit its deadline
 *      surfaces immediately in the dashboard.
 *
 * Single-flight is enforced by `withCronLock` (pg_try_advisory_lock
 * on a dedicated connection). When another tick is already running,
 * this one exits with 200 + `{ ran: false }` so Vercel doesn't retry
 * the no-op. The per-row claim inside `processNextVideo` uses
 * `SELECT FOR UPDATE SKIP LOCKED` as a second line of defence —
 * council-mandated both layers.
 *
 * Auth: existing CRON_SECRET pattern (matches `run-workflows`,
 * `poll-publishing`, etc.). Local-dev requests on
 * localhost/127.0.0.1 bypass the header check so the cron is
 * testable without env setup.
 */

export const maxDuration = 300;

/** How many videos to drain per tick. Each stage handler can take
 *  many seconds (script gen + critic panel are the worst); keep this
 *  conservative so the tick stays well inside the 300s ceiling. */
const DRAIN_PER_TICK = 5;

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
  logger.info('cron run-pipeline: start');

  const outcome = await withCronLock(CRON_LOCK_KEYS.pipelineRunner, async () => {
    // ─── Overdue sweep ──────────────────────────────────────────────
    // Flip waiting_narration rows past their deadline. Bounded to a
    // sane LIMIT — overdue rows persist and a later tick picks up
    // any leftovers.
    const overdue = await sql`
      UPDATE pipeline_run_videos
         SET stage = 'narration_overdue',
             updated_at = NOW()
       WHERE stage = 'waiting_narration'
         AND narration_deadline_at IS NOT NULL
         AND narration_deadline_at < NOW()
       RETURNING id
    `;

    // ─── Drain ──────────────────────────────────────────────────────
    // processNextVideo returns 'advanced' for every row that got
    // processed (advance or terminal failure — both count as work
    // done by this tick) or 'no_work' when the queue is empty.
    let advanced = 0;
    let noWork = false;
    for (let i = 0; i < DRAIN_PER_TICK; i++) {
      const result = await processNextVideo();
      if (result === 'advanced') advanced++;
      else {
        noWork = true;
        break;
      }
    }

    return {
      overdue: overdue.rowCount ?? 0,
      advanced,
      drained_to_empty: noWork,
    };
  });

  if (!outcome.ran) {
    logger.info('cron run-pipeline: skipped (another tick in flight)');
    return NextResponse.json({ ran: false, reason: 'busy' });
  }

  logger.info('cron run-pipeline: done', {
    duration_ms: Date.now() - startedAt,
    ...outcome.result,
  });
  return NextResponse.json({ ran: true, ...outcome.result });
}

// Vercel cron invokes the scheduled path with a GET request
// (https://vercel.com/docs/cron-jobs); a POST-only route 405s that GET
// and the cron never runs. Alias GET to POST so this minute-cron is
// actually wired up in production. Reads headers only, so GET is safe.
export const GET = POST;

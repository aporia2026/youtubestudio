/**
 * Niche-favorite brief retry cron — Phase 14 safety net.
 *
 * The primary path is the inline fire-and-forget kickoff from
 * `/api/niche-finder/favorites/[slug]/brief` (POST). That handles the
 * common case in <90s. This cron exists for the long tail:
 *
 *   - Serverless cold-start timeout cancelled the in-flight call.
 *   - Perplexity returned a transient 500 / 502.
 *   - The kickoff was triggered during a deploy that killed the
 *     background function before it finished.
 *
 * Each cron tick picks up rows with `status IN ('pending', 'failed')
 * AND attempts < 3 AND generated_at < NOW() - 30s` and runs them
 * through the shared `runAndPersistBrief`. The 30s floor stops the
 * cron from piling on top of inline kickoffs still in flight; the
 * `markBriefRunning` claim inside the runner is the serialization
 * point if two workers race.
 *
 * Auth gate matches other crons (Bearer CRON_SECRET; bypassed in
 * local dev). Cap MAX_BRIEFS_PER_RUN keeps the Vercel maxDuration
 * budget safe — each brief is ~30-90s on Sonar Deep Research.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { listBriefsDueForRetry } from '@/lib/niche-finder/brief-db';
import { runAndPersistBrief } from '@/lib/niche-finder/brief-runner';

export const maxDuration = 300;

const MAX_BRIEFS_PER_RUN = 4; // ~4 × 60-90s = within the 5-min budget

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
  logger.info('cron niche-finder-favorites-enrich: start');

  const due = await listBriefsDueForRetry(MAX_BRIEFS_PER_RUN);
  let ready = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of due) {
    try {
      const result = await runAndPersistBrief({
        workspaceId: row.workspace_id,
        briefId: row.id,
      });
      if (result.status === 'ready') ready++;
      else if (result.status === 'failed') failed++;
      else skipped++;
    } catch (err) {
      // runAndPersistBrief swallows errors and writes them to the row.
      // If something still escapes, count it as failed and move on —
      // we don't want one bad row to block the rest of the queue.
      failed++;
      logger.error('cron niche-finder-favorites-enrich: row escaped runner', {
        brief_id: row.id,
        workspace_id: row.workspace_id,
        niche_slug: row.niche_slug,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info('cron niche-finder-favorites-enrich: done', {
    duration_ms: durationMs,
    candidates: due.length,
    ready,
    failed,
    skipped,
  });

  return NextResponse.json({
    candidates: due.length,
    ready,
    failed,
    skipped,
    duration_ms: durationMs,
  });
}

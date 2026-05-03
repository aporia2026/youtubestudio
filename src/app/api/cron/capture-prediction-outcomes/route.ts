/**
 * Vercel cron entry — Phase 8.5 prediction-outcomes capture.
 *
 * Walks every (retention_predictions, video_analytics) pair where the
 * video has been live ≥ 14 days and no prediction_outcomes row exists
 * yet, and inserts one outcome row per pair (predicted curve + actual
 * curve + delta metrics).
 *
 * Closes the AI improvement loop: the predictor's few-shot RAG can
 * then prefer outcomes over raw analytics rows so the model gets
 * sharper on this user's specific channel over time.
 *
 * Wired in vercel.json daily at 03:15 UTC — chosen to avoid clashing
 * with the hourly `run-workflows` and `poll-publishing` crons.
 *
 * Same auth pattern as poll-publishing: CRON_SECRET in prod, no auth
 * on localhost dev.
 */
import { NextRequest, NextResponse } from 'next/server';
import { captureOutcomesForReadyVideos } from '@/lib/prediction-outcomes';
import { logger } from '@/lib/logger';

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
  logger.info('cron capture-prediction-outcomes: start');
  try {
    const result = await captureOutcomesForReadyVideos({ minDaysLive: 14, limit: 50 });
    logger.info('cron capture-prediction-outcomes: done', {
      duration_ms: Date.now() - startedAt,
      ...result,
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.error('cron capture-prediction-outcomes: threw', {
      duration_ms: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'cron failed' }, { status: 500 });
  }
}

export const GET = POST;

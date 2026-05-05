/**
 * Vercel cron entry — Phase 9.5 breakout detector.
 *
 * Runs every 6h, staggered after the snapshot cron so the latest
 * trajectory rows have a chance to land first. For each recently-
 * published video that hasn't fired yet, computes its first-48h
 * velocity, compares against the channel's 90th percentile across
 * the last 90 days, fires `video_breakout_detected` for qualifiers.
 *
 * Idempotent via UNIQUE on (workspace, youtube_video_id) in
 * video_breakout_fires — each video can fire at most once.
 */
import { NextRequest, NextResponse } from 'next/server';
import { detectAndFireBreakouts } from '@/lib/breakout-detector';
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
  logger.info('cron detect-breakouts: start');
  try {
    const result = await detectAndFireBreakouts({ limit: 100 });
    logger.info('cron detect-breakouts: done', {
      duration_ms: Date.now() - startedAt,
      ...result,
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.error('cron detect-breakouts: threw', {
      duration_ms: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'cron failed' }, { status: 500 });
  }
}

export const GET = POST;

/**
 * Vercel cron entry — Phase 9.1 analytics-history snapshots.
 *
 * Every 6 hours, snapshots fresh stats for every workspace's videos
 * published in the last 14 days into video_analytics_history. The
 * resulting time-series powers:
 *
 *   - 9.5 breakout detector (first-48h velocity vs the channel's 90th
 *     percentile)
 *   - 9.6 weekly digest (week-over-week deltas)
 *   - dashboard velocity sparklines + catalog explorer columns
 *
 * Same auth pattern as the other crons: CRON_SECRET in prod, no auth
 * on localhost dev. Wired in vercel.json on a 6h schedule (00:30 /
 * 06:30 / 12:30 / 18:30 UTC) — staggered off the hour to avoid
 * clashing with the other crons.
 */
import { NextRequest, NextResponse } from 'next/server';
import { snapshotRecentlyPublishedVideos } from '@/lib/analytics-history';
import { logger } from '@/lib/logger';

// Each video is two YouTube API calls; budget for slow channels.
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
  logger.info('cron snapshot-analytics: start');
  try {
    const result = await snapshotRecentlyPublishedVideos({
      lookbackDays: 14,
      minIntervalHours: 5,
      limit: 200,
    });
    logger.info('cron snapshot-analytics: done', {
      duration_ms: Date.now() - startedAt,
      ...result,
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.error('cron snapshot-analytics: threw', {
      duration_ms: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'cron failed' }, { status: 500 });
  }
}

export const GET = POST;

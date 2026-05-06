/**
 * Vercel cron entry — Phase 9.4 video format/topic tagging.
 *
 * Daily at 02:30 UTC, tags every untagged published video across all
 * workspaces. Bounded at 100 per run so a large backlog unwinds
 * gradually without spiking AI spend.
 *
 * Same auth pattern as the other crons.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tagUntaggedVideos } from '@/lib/format-tags';
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
  logger.info('cron tag-video-formats: start');
  try {
    const result = await tagUntaggedVideos({ limit: 100 });
    logger.info('cron tag-video-formats: done', {
      duration_ms: Date.now() - startedAt,
      ...result,
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.error('cron tag-video-formats: threw', {
      duration_ms: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'cron failed' }, { status: 500 });
  }
}

export const GET = POST;

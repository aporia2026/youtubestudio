/**
 * Vercel cron entry — drain pending publishes.
 *
 * Polls every row currently in 'processing' across every workspace and
 * flips it to 'live'/'failed' as YouTube reports. Also fails rows
 * stuck in 'queued'/'uploading' for > 1 hour (orchestrator died
 * mid-upload).
 *
 * Wired in vercel.json on the same hourly schedule as run-workflows.
 * Same auth pattern: CRON_SECRET in prod, no auth on localhost dev.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pollAllPendingPublishes } from '@/lib/publishing';
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
  logger.info('cron poll-publishing: start');
  try {
    const result = await pollAllPendingPublishes({ limit: 50 });
    logger.info('cron poll-publishing: done', {
      duration_ms: Date.now() - startedAt,
      ...result,
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.error('cron poll-publishing: threw', {
      duration_ms: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'cron failed' }, { status: 500 });
  }
}

export const GET = POST;

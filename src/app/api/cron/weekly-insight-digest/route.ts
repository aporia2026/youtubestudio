/**
 * Vercel cron entry — Phase 9.6 weekly insight digest.
 *
 * Runs Mondays 09:00 UTC. For every workspace with
 * weekly_digest_enabled=true, assembles inputs from 9.1/9.2/9.4/9.5,
 * runs an AI synthesis, persists the artifact, and fans out to:
 *   - Webhook subscribers filtered to weekly_insight_digest event
 *   - Email recipients (workspace override or owner fallback)
 *
 * Same auth pattern as the other crons.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runWeeklyDigestSweep } from '@/lib/weekly-digest';
import { logger } from '@/lib/logger';

// Each digest is one AI call + a few SELECTs + email sends. With
// many workspaces this can take a while; budget the full Vercel
// Pro ceiling.
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
  logger.info('cron weekly-insight-digest: start');
  try {
    const result = await runWeeklyDigestSweep();
    logger.info('cron weekly-insight-digest: done', {
      duration_ms: Date.now() - startedAt,
      scanned: result.scanned,
      generated: result.generated,
      skipped_no_activity: result.skipped_no_activity,
      errors: result.errors,
    });
    return NextResponse.json({
      scanned: result.scanned,
      generated: result.generated,
      skipped_no_activity: result.skipped_no_activity,
      errors: result.errors,
    });
  } catch (err) {
    logger.error('cron weekly-insight-digest: threw', {
      duration_ms: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'cron failed' }, { status: 500 });
  }
}

export const GET = POST;

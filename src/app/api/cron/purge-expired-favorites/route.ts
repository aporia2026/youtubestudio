/**
 * Daily soft-delete purge — Phase 14.
 *
 * Hard-deletes any `niche_favorites` row whose `deleted_at` is older
 * than 30 days. The cascade on `niche_favorite_videos` and
 * `niche_favorite_briefs` (FK ON DELETE CASCADE) cleans up children.
 *
 * Runs once a day at 01:00 UTC — quiet window, low contention. The
 * 30-day grace period for restore is enforced in the data layer
 * (`purgeExpiredFavorites` uses `WHERE deleted_at < NOW() - INTERVAL
 * '30 days'`), so the cron just has to fire; no math here.
 *
 * Auth gate matches every other cron (Bearer CRON_SECRET; bypassed in
 * local dev).
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { purgeExpiredFavorites } from '@/lib/niche-finder/favorites';

export const maxDuration = 60;

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
  logger.info('cron purge-expired-favorites: start');

  let purged = 0;
  try {
    purged = await purgeExpiredFavorites();
  } catch (err) {
    logger.error('cron purge-expired-favorites: purge failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Purge failed' }, { status: 502 });
  }

  const duration_ms = Date.now() - startedAt;
  logger.info('cron purge-expired-favorites: done', { duration_ms, purged });
  return NextResponse.json({ purged, duration_ms });
}

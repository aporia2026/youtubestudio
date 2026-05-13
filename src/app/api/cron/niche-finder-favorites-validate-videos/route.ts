/**
 * Ghost-reference guard cron — Phase 14.
 *
 * Walks `niche_favorite_videos` across every workspace, asking YouTube
 * whether each saved video still exists. Flips `is_removed_upstream`
 * so the UI can dim dead videos and the Sheets export can exclude them
 * without losing the historical record.
 *
 * Quota math: YouTube `videos.list` costs 1 unit per call regardless
 * of how many ids fit (up to 50). MAX_VIDEOS_PER_RUN of 500 = 10 API
 * calls = 10 units per cron tick. Daily quota cap (10k units) is never
 * threatened by this.
 *
 * Schedule: every 6 hours. With a 24h "re-validate after" floor in
 * the validator, this gives each row 4 chances per day to get
 * checked — enough to catch a deletion within ~12 hours typical.
 *
 * Auth: matches every other cron (Bearer CRON_SECRET; bypassed in
 * local dev).
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  chunkBatches,
  listVideosDueForValidation,
  validateVideoBatch,
  VIDEO_VALIDATION_BATCH_SIZE,
  type VideoValidationCandidate,
} from '@/lib/niche-finder/video-validator';

export const maxDuration = 300;

const MAX_VIDEOS_PER_RUN = 500;

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
  logger.info('cron niche-finder-favorites-validate-videos: start');

  let due: VideoValidationCandidate[];
  try {
    due = await listVideosDueForValidation(MAX_VIDEOS_PER_RUN);
  } catch (err) {
    logger.error('cron video-validator: due-list query failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Could not load videos due for validation' },
      { status: 502 },
    );
  }

  if (due.length === 0) {
    logger.info('cron niche-finder-favorites-validate-videos: nothing due');
    return NextResponse.json({ candidates: 0, batches: 0, checked: 0, newly_removed: 0, restored: 0 });
  }

  const batches = chunkBatches(due, VIDEO_VALIDATION_BATCH_SIZE);
  let checked = 0;
  let newly_removed = 0;
  let restored = 0;
  let failed_batches = 0;

  for (const batch of batches) {
    try {
      const result = await validateVideoBatch(batch);
      checked += result.checked;
      newly_removed += result.newly_removed;
      restored += result.restored;
    } catch (err) {
      failed_batches++;
      logger.warn('cron video-validator: batch failed', {
        batch_size: batch.length,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const duration_ms = Date.now() - startedAt;
  logger.info('cron niche-finder-favorites-validate-videos: done', {
    duration_ms,
    candidates: due.length,
    batches: batches.length,
    checked,
    newly_removed,
    restored,
    failed_batches,
  });

  return NextResponse.json({
    candidates: due.length,
    batches: batches.length,
    checked,
    newly_removed,
    restored,
    failed_batches,
    duration_ms,
  });
}

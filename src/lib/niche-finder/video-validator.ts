/**
 * Ghost-reference guard for `niche_favorite_videos`.
 *
 * YouTube videos saved as proof points can disappear after the fact —
 * deleted by the creator, set to private, age-gated for the API, or
 * region-blocked. Without a guard, exports keep citing dead URLs and
 * the proof-videos strip on the Favorites tab keeps rendering thumbnails
 * that won't load. The guard flips `is_removed_upstream` so the UI can
 * dim those cards and the exports can exclude them — without deleting
 * the row, because operators may still want the historical signal of
 * "this was a winner before the channel pulled it."
 *
 * The cron (`/api/cron/niche-finder-favorites-validate-videos`) calls
 * `validateVideoBatch` for every stale row, batched 50 at a time to
 * respect the YouTube Data API's `videos.list` page size. Quota cost:
 * 1 unit per `videos.list` call (regardless of how many ids fit in
 * that call), so 50 ids = 1 unit. 1000 videos checked = 20 units.
 * Trivial compared to the 10,000-unit daily quota.
 *
 * Module is cron/server-only — uses YOUTUBE_API_KEY directly.
 */
import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';

/** Max ids per YouTube `videos.list` call. The endpoint accepts up to
 *  50 comma-separated ids per request. */
export const VIDEO_VALIDATION_BATCH_SIZE = 50;

/** How stale a row must be before the cron re-validates it. 24h keeps
 *  the proof strips honest without burning quota on fresh saves. */
export const VIDEO_REVALIDATE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface VideoValidationCandidate {
  id: string;
  video_id: string;
  workspace_id: string;
  niche_slug: string;
  is_removed_upstream: boolean;
}

/** List videos due for revalidation across ALL workspaces — this is a
 *  global cron query, not session-scoped. Picks the stalest rows first
 *  so the cron makes forward progress on a slowly-growing backlog. */
export async function listVideosDueForValidation(
  maxRows: number,
): Promise<VideoValidationCandidate[]> {
  const cutoff = new Date(Date.now() - VIDEO_REVALIDATE_AFTER_MS).toISOString();
  const { rows } = await sql<VideoValidationCandidate>`
    SELECT id::text, video_id, workspace_id::text, niche_slug, is_removed_upstream
      FROM niche_favorite_videos
     WHERE last_validated_at IS NULL
        OR last_validated_at < ${cutoff}::timestamptz
     ORDER BY last_validated_at NULLS FIRST, added_at ASC
     LIMIT ${maxRows}
  `;
  return rows;
}

interface ValidationBatchResult {
  checked: number;
  /** Number of rows flipped to `is_removed_upstream=true` this batch. */
  newly_removed: number;
  /** Number of rows that came back to life (re-uploaded / unprivated). */
  restored: number;
}

/** Call YouTube's videos.list for the batch's video ids, mark every
 *  row's `last_validated_at`, and flip `is_removed_upstream` based on
 *  whether the id was in the response.
 *
 *  Returns counts so the cron can log them. Network / quota failures
 *  surface as thrown errors — the cron catches them per-batch so one
 *  bad batch doesn't poison the whole run. */
export async function validateVideoBatch(
  batch: VideoValidationCandidate[],
): Promise<ValidationBatchResult> {
  if (batch.length === 0) return { checked: 0, newly_removed: 0, restored: 0 };
  if (batch.length > VIDEO_VALIDATION_BATCH_SIZE) {
    throw new Error(
      `validateVideoBatch: batch of ${batch.length} exceeds YouTube videos.list cap of ${VIDEO_VALIDATION_BATCH_SIZE}`,
    );
  }
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY is not configured — ghost-reference guard cannot run.');
  }

  // Dedupe ids across the batch so we don't blow ids on duplicate
  // saves in different niches. (UNIQUE constraint is per (workspace,
  // niche_slug, video_id) so the same video CAN live in multiple
  // favorites; one API call validates all copies.)
  const idToRows = new Map<string, VideoValidationCandidate[]>();
  for (const row of batch) {
    const list = idToRows.get(row.video_id);
    if (list) list.push(row);
    else idToRows.set(row.video_id, [row]);
  }
  const uniqueIds = [...idToRows.keys()];

  const url = `https://www.googleapis.com/youtube/v3/videos?part=id&id=${encodeURIComponent(uniqueIds.join(','))}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`YouTube videos.list ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { items?: Array<{ id?: string }> };
  const liveIds = new Set<string>();
  for (const item of data.items ?? []) {
    if (typeof item.id === 'string') liveIds.add(item.id);
  }

  // Categorize rows: still live, newly-removed, or restored.
  const stillLive: string[] = [];
  const newlyRemoved: string[] = [];
  const restored: string[] = [];

  for (const row of batch) {
    const isLive = liveIds.has(row.video_id);
    if (isLive) {
      stillLive.push(row.id);
      if (row.is_removed_upstream) restored.push(row.id);
    } else {
      newlyRemoved.push(row.id);
    }
  }

  // Two UPDATEs — one per state. The is_removed_upstream column toggles
  // both directions: a video that comes back gets restored to live.
  if (stillLive.length > 0) {
    await sql.query(
      `UPDATE niche_favorite_videos
         SET last_validated_at  = NOW(),
             is_removed_upstream = FALSE
       WHERE id = ANY($1::uuid[])`,
      [stillLive],
    );
  }
  if (newlyRemoved.length > 0) {
    await sql.query(
      `UPDATE niche_favorite_videos
         SET last_validated_at  = NOW(),
             is_removed_upstream = TRUE
       WHERE id = ANY($1::uuid[])`,
      [newlyRemoved],
    );
  }

  // Only the rows that flipped TO removed count as "newly removed" —
  // rows that were already removed and still are don't get re-counted.
  const newly_removed_count = batch.filter(
    (row) => !liveIds.has(row.video_id) && !row.is_removed_upstream,
  ).length;

  logger.debug('video-validator: batch processed', {
    checked: batch.length,
    unique_ids: uniqueIds.length,
    live: stillLive.length,
    removed: newlyRemoved.length,
    newly_removed: newly_removed_count,
    restored: restored.length,
  });

  return {
    checked: batch.length,
    newly_removed: newly_removed_count,
    restored: restored.length,
  };
}

/** Helper for tests: split an array into batches of N. Pure. */
export function chunkBatches<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunkBatches: size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

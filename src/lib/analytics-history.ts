/**
 * Phase 9.1 — time-series snapshots of video_analytics.
 *
 * Foundation for Phase 9.5 (breakout detector — needs first-48h
 * velocity), 9.6 (weekly digest — needs week-over-week trajectories),
 * and the catalog explorer (9.7 velocity columns).
 *
 * Pure helpers (`computeViewVelocityPerHour`, `bucketByDay`,
 * `percentileOfVelocity`) are exported for unit tests so the math
 * stays honest without a DB. DB wrappers handle:
 *
 *   - `appendAnalyticsHistory(workspace, source, opts)` — copy the
 *     just-synced video_analytics row into the history table, gated
 *     on a minimum interval (default 5h) to dedup near-duplicate
 *     cron tick + on-demand sync writes.
 *   - `getAnalyticsHistory(workspace, videoId, opts)` — pull the
 *     trajectory for one video, newest-first.
 *   - `snapshotRecentlyPublishedVideos(opts)` — orchestrator the
 *     `/api/cron/snapshot-analytics` cron drives. Walks every channel's
 *     videos published in the lookback window, calls syncVideoAnalytics
 *     (which upserts video_analytics) THEN appends the history row.
 *
 * Why a separate cron rather than piggyback on the existing on-demand
 * sync: cadence-driven trajectory is the whole point. Without a
 * regular tick the history table has gaps wherever the user wasn't
 * actively browsing the analytics page, which kills 9.5's percentile
 * math.
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { syncVideoAnalytics, type VideoAnalyticsRow } from './youtube-analytics';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoAnalyticsHistoryRow {
  workspace_id: string;
  youtube_video_id: string;
  channel_id: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  impressions: number | null;
  ctr_percentage: number | null;
  average_view_duration_seconds: number | null;
  average_view_percentage: number | null;
  subscribers_gained: number | null;
  data_source: string;
  captured_at: string;
}

export interface DailyBucket {
  /** ISO date string YYYY-MM-DD (UTC). */
  date: string;
  /** End-of-day snapshot (latest within the day) views value. */
  views: number;
  /** Views gained during the day = today.views - yesterday.views.
   *  null for the first day in the series (no prior day to diff). */
  views_gained: number | null;
  /** Latest CTR + AVP within the day, null when the column was unset
   *  in every snapshot (data-only sync, no analytics scope). */
  ctr_percentage: number | null;
  average_view_percentage: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Views gained per hour, computed from the first and last snapshots in
 * `rows`. Rows are expected newest-first (matches getAnalyticsHistory's
 * default order); we sort defensively anyway.
 *
 * Returns null when the window is too short (< 1h between rows) or
 * the views column is unset in either bookend — no signal beats wrong
 * signal.
 */
export function computeViewVelocityPerHour(
  rows: Array<Pick<VideoAnalyticsHistoryRow, 'views' | 'captured_at'>>,
): number | null {
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) =>
    a.captured_at.localeCompare(b.captured_at),
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (first.views === null || last.views === null) return null;
  const ms = new Date(last.captured_at).getTime() - new Date(first.captured_at).getTime();
  if (!Number.isFinite(ms) || ms < 60 * 60 * 1000) return null;
  const hours = ms / (60 * 60 * 1000);
  const delta = last.views - first.views;
  return delta / hours;
}

/**
 * Bucket history rows by UTC day. Each bucket carries the LATEST
 * within-day snapshot's view count + CTR + AVP, plus a `views_gained`
 * = (today's views) - (yesterday's views). The first day's
 * `views_gained` is null (nothing to diff against).
 *
 * Used by the dashboard's velocity sparkline + the catalog explorer.
 */
export function bucketByDay(
  rows: Array<Pick<
    VideoAnalyticsHistoryRow,
    'views' | 'ctr_percentage' | 'average_view_percentage' | 'captured_at'
  >>,
): DailyBucket[] {
  if (rows.length === 0) return [];

  // Group: keep only the LATEST snapshot per (UTC) day.
  const sorted = [...rows].sort((a, b) =>
    a.captured_at.localeCompare(b.captured_at),
  );
  const byDay = new Map<string, (typeof sorted)[number]>();
  for (const r of sorted) {
    const day = r.captured_at.slice(0, 10); // YYYY-MM-DD from ISO
    byDay.set(day, r); // last write wins → end-of-day snapshot
  }

  const days = [...byDay.keys()].sort(); // ascending
  const out: DailyBucket[] = [];
  let prevViews: number | null = null;
  for (const day of days) {
    const r = byDay.get(day)!;
    const viewsToday = typeof r.views === 'number' ? r.views : 0;
    const gained =
      prevViews === null
        ? null
        : Math.max(0, viewsToday - prevViews); // clamp negatives — YouTube can re-count
    out.push({
      date: day,
      views: viewsToday,
      views_gained: gained,
      ctr_percentage: r.ctr_percentage ?? null,
      average_view_percentage: r.average_view_percentage ?? null,
    });
    prevViews = viewsToday;
  }
  return out;
}

/**
 * Compute the percentile rank (0..1) of `value` within `population`.
 * Used by 9.5's breakout detector: "is this video's first-48h
 * velocity above the channel's 90th percentile?"
 *
 * Returns null when population is empty (cold-start channel — caller
 * decides whether to fall back to a fixed threshold or skip).
 *
 * Pure: no DB, no I/O. The caller pre-filters the population set
 * (e.g. only first-48h velocities from this channel).
 */
export function percentileOfVelocity(
  value: number,
  population: number[],
): number | null {
  if (population.length === 0) return null;
  let belowOrEqual = 0;
  for (const v of population) {
    if (v <= value) belowOrEqual += 1;
  }
  return belowOrEqual / population.length;
}

// ---------------------------------------------------------------------------
// DB wrappers
// ---------------------------------------------------------------------------

/**
 * Append a snapshot to video_analytics_history. No-ops when the most
 * recent snapshot for this video is fresher than `minIntervalHours`
 * (default 5h) — keeps the cron's 6h cadence from accidentally
 * doubling up when an on-demand sync fires shortly after.
 *
 * Returns { inserted: true } when the row was written, { inserted:
 * false, reason } when skipped.
 */
export async function appendAnalyticsHistory(
  workspaceId: string,
  source: VideoAnalyticsRow,
  opts: { minIntervalHours?: number } = {},
): Promise<{ inserted: boolean; reason?: string }> {
  const minHours = Math.max(0, opts.minIntervalHours ?? 5);
  if (minHours > 0) {
    // Cheap dedup: check the most-recent captured_at first.
    const { rows } = await sql<{ captured_at: string }>`
      SELECT captured_at::text AS captured_at
        FROM video_analytics_history
       WHERE workspace_id     = ${workspaceId}::uuid
         AND youtube_video_id = ${source.youtube_video_id}
       ORDER BY captured_at DESC
       LIMIT 1
    `;
    if (rows[0]) {
      const lastMs = new Date(rows[0].captured_at).getTime();
      const ageMs = Date.now() - lastMs;
      if (Number.isFinite(ageMs) && ageMs < minHours * 60 * 60 * 1000) {
        return { inserted: false, reason: 'too-recent' };
      }
    }
  }

  await sql`
    INSERT INTO video_analytics_history (
      workspace_id, youtube_video_id, channel_id,
      views, likes, comments,
      impressions, ctr_percentage,
      average_view_duration_seconds, average_view_percentage,
      subscribers_gained,
      data_source
    ) VALUES (
      ${workspaceId}::uuid, ${source.youtube_video_id}, ${source.channel_id ?? null}::uuid,
      ${source.views}, ${source.likes}, ${source.comments},
      ${source.impressions}, ${source.ctr_percentage},
      ${source.average_view_duration_seconds}, ${source.average_view_percentage},
      ${source.subscribers_gained},
      ${source.data_source}
    )
  `;
  return { inserted: true };
}

/** Pull trajectory for one video, newest-first. */
export async function getAnalyticsHistory(
  workspaceId: string,
  youtubeVideoId: string,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<VideoAnalyticsHistoryRow[]> {
  const sinceDays = Math.max(1, opts.sinceDays ?? 30);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const { rows } = await sql<VideoAnalyticsHistoryRow>`
    SELECT
      workspace_id, youtube_video_id, channel_id,
      views, likes, comments, impressions, ctr_percentage,
      average_view_duration_seconds, average_view_percentage,
      subscribers_gained, data_source,
      captured_at::text AS captured_at
    FROM video_analytics_history
    WHERE workspace_id     = ${workspaceId}::uuid
      AND youtube_video_id = ${youtubeVideoId}
      AND captured_at      > (NOW() - (${`${sinceDays} days`})::interval)
    ORDER BY captured_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Cron orchestrator
// ---------------------------------------------------------------------------

interface SnapshotCandidate {
  workspace_id: string;
  youtube_video_id: string;
  channel_db_id: string | null;
  youtube_channel_id: string | null;
}

export interface SnapshotResult {
  scanned: number;
  synced: number;
  appended: number;
  skipped_too_recent: number;
  errors: number;
}

/**
 * Walk every workspace's recently-published videos and append a
 * history snapshot for each. The snapshot path is:
 *
 *   1. SELECT distinct (workspace_id, youtube_video_id, channel_db_id,
 *      yt_channel_id) from video_analytics where the video was
 *      published within the lookback window.
 *   2. For each: call syncVideoAnalytics (which upserts the live
 *      video_analytics row with fresh stats from YouTube).
 *   3. Then appendAnalyticsHistory with the freshly-synced row,
 *      gated on minIntervalHours.
 *
 * Errors per-video are caught + counted but don't fail the whole
 * cron. The cron log line shows the per-bucket counts.
 *
 * Defaults: 14-day lookback (matches Phase 8.5's outcome window),
 * limit 200 candidates per run (Vercel cron has a 300s ceiling and
 * each video is two YouTube API calls — keep it bounded).
 */
export async function snapshotRecentlyPublishedVideos(
  opts: { lookbackDays?: number; minIntervalHours?: number; limit?: number } = {},
): Promise<SnapshotResult> {
  const lookbackDays = Math.max(1, opts.lookbackDays ?? 14);
  const minIntervalHours = Math.max(0, opts.minIntervalHours ?? 5);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  const { rows: candidates } = await sql<SnapshotCandidate>`
    SELECT DISTINCT
      va.workspace_id,
      va.youtube_video_id,
      va.channel_id      AS channel_db_id,
      ch.channel_id      AS youtube_channel_id
    FROM video_analytics va
    LEFT JOIN channels ch ON ch.id = va.channel_id
    WHERE va.published_at IS NOT NULL
      AND va.published_at > (NOW() - (${`${lookbackDays} days`})::interval)
    ORDER BY va.youtube_video_id
    LIMIT ${limit}
  `;

  let synced = 0;
  let appended = 0;
  let skipped = 0;
  let errors = 0;

  for (const c of candidates) {
    if (!c.channel_db_id) {
      // Without a channel link there's no OAuth token to call YouTube
      // — skip rather than fail.
      errors += 1;
      continue;
    }
    try {
      const refreshed = await syncVideoAnalytics({
        workspaceId: c.workspace_id,
        channelDbId: c.channel_db_id,
        youtubeVideoId: c.youtube_video_id,
        youtubeChannelId: c.youtube_channel_id ?? null,
        scheduleItemId: null,
      });
      synced += 1;
      const result = await appendAnalyticsHistory(c.workspace_id, refreshed, {
        minIntervalHours,
      });
      if (result.inserted) appended += 1;
      else skipped += 1;
    } catch (err) {
      errors += 1;
      logger.warn('analytics-history snapshot failed for one video', {
        workspace_id: c.workspace_id,
        youtube_video_id: c.youtube_video_id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    scanned: candidates.length,
    synced,
    appended,
    skipped_too_recent: skipped,
    errors,
  };
}

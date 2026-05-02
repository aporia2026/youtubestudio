/**
 * Cross-competitor aggregations for the competitor dashboard +
 * a compact "competitor signals" card on the main dashboard.
 *
 * The detailed `/competitors/[id]` page already exposes everything per-
 * competitor; this module is for the higher-leverage *cross-competitor*
 * view: which channel just had a breakout, who's accelerating cadence,
 * what content gaps appear across multiple competitors.
 *
 * Pure helpers (computeMomentum, classifyOutlier) are exported for
 * unit tests so the math stays honest as the dataset grows.
 */
import { sql } from '@vercel/postgres';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompetitorChannelSummary {
  id: string;
  channel_id: string;
  title: string;
  custom_url: string | null;
  thumbnail_url: string | null;
  subscriber_count: number;
  video_count_total: number;
  videos_tracked: number;
  videos_last_7_days: number;
  videos_prior_7_days: number;
  /** Multiplicative change in upload cadence: 1.0 = same as prior week,
   *  2.0 = doubled, 0.5 = halved. Null when the prior window is empty
   *  (would divide by zero). */
  momentum: number | null;
  median_view_count_30d: number | null;
  last_uploaded_at: string | null;
  last_synced_at: string | null;
}

export interface RecentBreakout {
  competitor_id: string;
  competitor_title: string;
  video_id: string;
  video_title: string;
  thumbnail_url: string | null;
  view_count: number;
  outlier_score: number;
  /** view_count divided by the competitor's median over 30 days. Null
   *  when no baseline (channel too new or median is 0). */
  vs_median_factor: number | null;
  published_at: string | null;
}

export interface CompetitorSignals {
  channel_count: number;
  videos_tracked: number;
  videos_last_7_days: number;
  /** Channels in which uploads-this-week >= 1.5× prior-week. Aggregate
   *  count surfaces the "hot competitor" signal without overwhelming
   *  the small dashboard card. */
  channels_accelerating: number;
  most_recent_breakout: RecentBreakout | null;
  oldest_unsynced_hours: number | null;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Multiplicative momentum: this-week / prior-week. Returns null when
 *  prior is 0 (avoid divide-by-zero blow-ups in the dashboard). */
export function computeMomentum(thisWeek: number, priorWeek: number): number | null {
  if (priorWeek <= 0) return thisWeek > 0 ? null : 0;
  return thisWeek / priorWeek;
}

/** Classify a breakout's severity by its vs-median factor. Used by the
 *  UI to choose the row's accent color. */
export function classifyOutlier(vsMedian: number | null): 'normal' | 'breakout' | 'viral' {
  if (vsMedian === null) return 'normal';
  if (vsMedian >= 5) return 'viral';
  if (vsMedian >= 2.5) return 'breakout';
  return 'normal';
}

// ---------------------------------------------------------------------------
// DB-backed aggregators
// ---------------------------------------------------------------------------

interface RawChannelSummaryRow {
  id: string;
  channel_id: string;
  title: string;
  custom_url: string | null;
  thumbnail_url: string | null;
  subscriber_count: string | number;
  video_count: string | number;
  videos_tracked: string | number;
  videos_last_7_days: string | number;
  videos_prior_7_days: string | number;
  median_view_count_30d: string | number | null;
  last_uploaded_at: string | null;
  last_synced_at: string | null;
}

/**
 * One row per competitor, with cadence numbers and a 30-day median view
 * count baseline. Single SQL query so the page renders fast even with
 * dozens of competitors and tens of thousands of videos.
 */
export async function listCompetitorSummaries(workspaceId: string): Promise<CompetitorChannelSummary[]> {
  const { rows } = await sql<RawChannelSummaryRow>`
    SELECT
      c.id, c.channel_id, c.title, c.custom_url, c.thumbnail_url,
      c.subscriber_count, c.video_count,
      COUNT(v.id) AS videos_tracked,
      COUNT(v.id) FILTER (WHERE v.published_at >= NOW() - INTERVAL '7 days') AS videos_last_7_days,
      COUNT(v.id) FILTER (WHERE v.published_at >= NOW() - INTERVAL '14 days' AND v.published_at < NOW() - INTERVAL '7 days') AS videos_prior_7_days,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count)
        FILTER (WHERE v.published_at >= NOW() - INTERVAL '30 days') AS median_view_count_30d,
      MAX(v.published_at)::text AS last_uploaded_at,
      MAX(v.synced_at)::text AS last_synced_at
    FROM competitor_channels c
    LEFT JOIN competitor_videos v
      ON v.competitor_id = c.id
     AND v.workspace_id = ${workspaceId}::uuid
    WHERE c.workspace_id = ${workspaceId}::uuid
    GROUP BY c.id
    ORDER BY videos_last_7_days DESC NULLS LAST, c.title ASC
  `;
  return rows.map((r) => {
    const thisWeek = Number(r.videos_last_7_days) || 0;
    const priorWeek = Number(r.videos_prior_7_days) || 0;
    return {
      id: r.id,
      channel_id: r.channel_id,
      title: r.title,
      custom_url: r.custom_url,
      thumbnail_url: r.thumbnail_url,
      subscriber_count: Number(r.subscriber_count) || 0,
      video_count_total: Number(r.video_count) || 0,
      videos_tracked: Number(r.videos_tracked) || 0,
      videos_last_7_days: thisWeek,
      videos_prior_7_days: priorWeek,
      momentum: computeMomentum(thisWeek, priorWeek),
      median_view_count_30d: r.median_view_count_30d !== null ? Number(r.median_view_count_30d) : null,
      last_uploaded_at: r.last_uploaded_at,
      last_synced_at: r.last_synced_at,
    } satisfies CompetitorChannelSummary;
  });
}

interface RawBreakoutRow {
  competitor_id: string;
  competitor_title: string;
  video_id: string;
  video_title: string;
  thumbnail_url: string | null;
  view_count: string | number;
  outlier_score: string | number;
  median_view_count_30d: string | number | null;
  published_at: string | null;
}

/**
 * Recent videos that significantly outperformed the competitor's
 * 30-day median. Returned newest first (so the dashboard surfaces
 * "what just popped" rather than "the all-time biggest hit").
 *
 * `outlier_score` is computed by the existing sync route; we use
 * vs-median as a secondary filter so a video can be a "breakout"
 * even when outlier_score is missing on older syncs.
 */
export async function listRecentBreakouts(
  workspaceId: string,
  opts: { lookbackDays?: number; minVsMedian?: number; limit?: number } = {},
): Promise<RecentBreakout[]> {
  const lookback = Math.max(1, Math.min(opts.lookbackDays ?? 14, 60));
  const minVs = Math.max(1.5, opts.minVsMedian ?? 2.5);
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const { rows } = await sql<RawBreakoutRow>`
    WITH baseline AS (
      SELECT competitor_id,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY view_count) AS median_view_count_30d
        FROM competitor_videos
       WHERE workspace_id = ${workspaceId}::uuid
         AND published_at >= NOW() - INTERVAL '30 days'
       GROUP BY competitor_id
    )
    SELECT
      v.competitor_id,
      c.title AS competitor_title,
      v.video_id,
      v.title AS video_title,
      v.thumbnail_url,
      v.view_count,
      v.outlier_score,
      b.median_view_count_30d,
      v.published_at::text AS published_at
    FROM competitor_videos v
    JOIN competitor_channels c ON c.id = v.competitor_id
    LEFT JOIN baseline b ON b.competitor_id = v.competitor_id
    WHERE v.workspace_id = ${workspaceId}::uuid
      AND v.published_at >= NOW() - (${lookback}::int * INTERVAL '1 day')
      AND (
        (b.median_view_count_30d IS NOT NULL AND b.median_view_count_30d > 0
          AND v.view_count >= b.median_view_count_30d * ${minVs})
        OR v.outlier_score >= ${minVs}
      )
    ORDER BY v.published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows.map((r) => {
    const median = r.median_view_count_30d !== null ? Number(r.median_view_count_30d) : null;
    const vsMedian = median !== null && median > 0 ? Number(r.view_count) / median : null;
    return {
      competitor_id: r.competitor_id,
      competitor_title: r.competitor_title,
      video_id: r.video_id,
      video_title: r.video_title,
      thumbnail_url: r.thumbnail_url,
      view_count: Number(r.view_count) || 0,
      outlier_score: Number(r.outlier_score) || 0,
      vs_median_factor: vsMedian,
      published_at: r.published_at,
    };
  });
}

/**
 * Compact summary for the main dashboard card. Hits the DB twice
 * (channels + breakouts), then squashes into the single
 * CompetitorSignals shape.
 */
export async function getCompetitorSignals(workspaceId: string): Promise<CompetitorSignals> {
  const summaries = await listCompetitorSummaries(workspaceId);
  const breakouts = await listRecentBreakouts(workspaceId, { lookbackDays: 14, minVsMedian: 2.5, limit: 1 });

  const accelerating = summaries.filter(
    (s) => s.momentum !== null && s.momentum >= 1.5 && s.videos_last_7_days >= 2,
  ).length;
  const oldestUnsyncedMs = summaries
    .map((s) => (s.last_synced_at ? Date.parse(s.last_synced_at) : null))
    .filter((t): t is number => t !== null)
    .reduce<number | null>((acc, t) => (acc === null || t < acc ? t : acc), null);
  const oldestUnsyncedHours =
    oldestUnsyncedMs !== null ? Math.round((Date.now() - oldestUnsyncedMs) / 3_600_000) : null;

  return {
    channel_count: summaries.length,
    videos_tracked: summaries.reduce((acc, s) => acc + s.videos_tracked, 0),
    videos_last_7_days: summaries.reduce((acc, s) => acc + s.videos_last_7_days, 0),
    channels_accelerating: accelerating,
    most_recent_breakout: breakouts[0] ?? null,
    oldest_unsynced_hours: oldestUnsyncedHours,
    generated_at: new Date().toISOString(),
  };
}

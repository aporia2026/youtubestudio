/**
 * Phase 9.5 — breakout / anomaly detector.
 *
 * Walks every channel's recent videos, computes first-48h view
 * velocity from `video_analytics_history`, compares each candidate
 * against the channel's 90th-percentile velocity over the last 90
 * days, and fires `video_breakout_detected` for the outliers.
 *
 * Hard idempotency via `video_breakout_fires` UNIQUE — each video
 * can fire at most once. A slow-burn that creeps above the
 * percentile every 6h doesn't spam.
 *
 * Pure helpers:
 *   - `computeFirstWindowVelocity` — pulls views-per-hour from a
 *     trajectory across the first N hours since publish
 *   - `qualifiesAsBreakout` — applies the threshold logic given a
 *     candidate's velocity + the channel's percentile baseline
 *
 * DB orchestrator `detectAndFireBreakouts` joins everything in a
 * single CTE query (Phase 9.8.2 — was N+1, would time out at scale)
 * and dispatches the events through the existing webhook + workflow
 * fan-out. Dispatch is awaited inline (Phase 9.8.2 — was fire-and-
 * forget which loses notifications when Vercel freezes the function
 * after the cron's response promise resolves).
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { computeViewVelocityPerHour, percentileOfVelocity } from './analytics-history';
import { escapeSlackText } from './slack-escape';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BreakoutCandidate {
  workspace_id: string;
  youtube_video_id: string;
  channel_id: string | null;
  title: string | null;
  published_at: string;
}

interface HistoryRow {
  views: number | null;
  captured_at: string;
}

export interface BreakoutDecision {
  qualifies: boolean;
  velocity: number;
  percentile: number;
  channel_p90: number;
}

export interface DetectorResult {
  scanned: number;
  fired: number;
  skipped_already_fired: number;
  skipped_no_data: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Hours between two ISO timestamps. Returns null when either is unparseable. */
export function hoursBetween(from: string, to: string): number | null {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / (60 * 60 * 1000);
}

/**
 * Filter `rows` to those whose captured_at is within the first
 * `windowHours` since `publishedAt`, then call computeViewVelocityPerHour.
 * Pure: no DB.
 */
export function computeFirstWindowVelocity(
  rows: HistoryRow[],
  publishedAt: string,
  windowHours: number,
): number | null {
  const inWindow = rows.filter((r) => {
    const dh = hoursBetween(publishedAt, r.captured_at);
    return dh !== null && dh >= 0 && dh <= windowHours;
  });
  return computeViewVelocityPerHour(inWindow);
}

/**
 * Given a candidate's velocity and the channel's velocity population,
 * decide whether the candidate qualifies as a breakout.
 *
 * Threshold: percentile ≥ 0.9 AND velocity strictly greater than the
 * channel's p90 (the strict-greater clause prevents a tie at p90 from
 * triggering — otherwise a flat channel would constantly self-fire).
 *
 * Population is required to have at least `minPopulation` (default 5)
 * entries — fewer than that is too sparse to compute a meaningful
 * percentile and the detector backs off.
 */
export function qualifiesAsBreakout(
  velocity: number,
  channelPopulation: number[],
  opts: { percentileThreshold?: number; minPopulation?: number } = {},
): BreakoutDecision {
  const minPopulation = opts.minPopulation ?? 5;
  const threshold = opts.percentileThreshold ?? 0.9;
  if (channelPopulation.length < minPopulation) {
    return { qualifies: false, velocity, percentile: 0, channel_p90: 0 };
  }
  const sorted = [...channelPopulation].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(threshold * sorted.length) - 1);
  const p90 = sorted[Math.max(0, idx)]!;
  const pct = percentileOfVelocity(velocity, channelPopulation) ?? 0;
  return {
    qualifies: pct >= threshold && velocity > p90,
    velocity,
    percentile: pct,
    channel_p90: p90,
  };
}

// ---------------------------------------------------------------------------
// DB orchestrator
// ---------------------------------------------------------------------------

const FIRST_WINDOW_HOURS = 48;
const POPULATION_LOOKBACK_DAYS = 90;
const RECENT_PUBLISH_LOOKBACK_DAYS = 7;

/**
 * Walk every workspace's videos published in the last 7 days, compute
 * each one's first-48h velocity, compare against the channel's p90
 * across the last 90 days, and fire `video_breakout_detected` for
 * qualifiers.
 *
 * Phase 9.8.2 — rewritten as a single CTE query. The previous version
 * was N+1 (1 outer SELECT + 1 query per candidate's channel + N
 * trajectory queries per video on that channel) — at 100 candidates
 * × 200 videos/channel × 5ms it would routinely exceed the cron's
 * 300s timeout. The new shape:
 *
 *   1. velocities CTE: per-video first-48h velocity for every
 *      workspace's videos in the last 90 days.
 *   2. channel_p90 CTE: percentile_cont(0.9) per (workspace, channel)
 *      with a min-population guard of 5.
 *   3. Final SELECT: candidates published in the last 7 days, not yet
 *      fired, whose velocity strictly exceeds the channel's p90,
 *      annotated with a CUME_DIST() percentile rank within the
 *      population. One round-trip total.
 *
 * Skip rules:
 *   - Already fired (UNIQUE catches this).
 *   - Less than 2 history rows in the window (`HAVING COUNT(*) >= 2`).
 *   - Channel has fewer than 5 prior video velocities to baseline
 *     against (`HAVING COUNT(*) >= 5` in channel_p90).
 *   - Velocity ≤ p90 (strict-greater prevents flat-channel self-fires).
 *
 * Dispatch is awaited inline so Vercel's freeze-after-response
 * semantics can't drop the notification.
 */

interface QualifyingBreakout {
  workspace_id: string;
  youtube_video_id: string;
  channel_id: string;
  title: string | null;
  published_at: string;
  velocity_per_hour: number;
  channel_p90: number;
  pop_size: number;
  percentile: number;
}

export async function detectAndFireBreakouts(
  opts: { limit?: number } = {},
): Promise<DetectorResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  // Single-query channel-population join. PG `percentile_cont` is the
  // continuous 90th percentile; CUME_DIST() gives the candidate's
  // fraction-of-population-≤ value (matches percentileOfVelocity's
  // semantics in the JS lib).
  //
  // The first/last view samples come from `array_agg(views ORDER BY
  // captured_at)` rather than MIN/MAX so a YouTube re-count
  // (views go down) yields a negative velocity that drops out of the
  // > p90 filter — same behaviour the JS computeFirstWindowVelocity
  // had before.
  const { rows: qualifiers } = await sql<QualifyingBreakout>`
    WITH velocities AS (
      SELECT
        h.workspace_id,
        h.youtube_video_id,
        va.channel_id,
        va.published_at,
        va.title,
        CASE
          WHEN MAX(h.captured_at) - MIN(h.captured_at) < INTERVAL '1 hour' THEN NULL
          ELSE
            ((array_agg(h.views ORDER BY h.captured_at DESC))[1] -
             (array_agg(h.views ORDER BY h.captured_at ASC))[1])::numeric /
            (EXTRACT(EPOCH FROM (MAX(h.captured_at) - MIN(h.captured_at))) / 3600.0)
        END AS velocity_per_hour
      FROM video_analytics_history h
      JOIN video_analytics va
        ON va.workspace_id     = h.workspace_id
       AND va.youtube_video_id = h.youtube_video_id
      WHERE va.published_at IS NOT NULL
        AND va.channel_id IS NOT NULL
        AND h.captured_at >= va.published_at
        AND h.captured_at <= (va.published_at + (${`${FIRST_WINDOW_HOURS} hours`})::interval)
        AND va.published_at > (NOW() - (${`${POPULATION_LOOKBACK_DAYS} days`})::interval)
      GROUP BY h.workspace_id, h.youtube_video_id, va.channel_id, va.published_at, va.title
      HAVING COUNT(*) >= 2
    ),
    channel_p90 AS (
      SELECT
        workspace_id,
        channel_id,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY velocity_per_hour) AS p90,
        COUNT(*)::int AS pop_size
      FROM velocities
      WHERE velocity_per_hour IS NOT NULL
      GROUP BY workspace_id, channel_id
      HAVING COUNT(*) >= 5
    )
    SELECT
      v.workspace_id::text AS workspace_id,
      v.youtube_video_id,
      v.channel_id::text AS channel_id,
      v.title,
      v.published_at::text AS published_at,
      v.velocity_per_hour::float AS velocity_per_hour,
      p.p90::float AS channel_p90,
      p.pop_size,
      CUME_DIST() OVER (
        PARTITION BY v.workspace_id, v.channel_id
        ORDER BY v.velocity_per_hour
      )::float AS percentile
    FROM velocities v
    JOIN channel_p90 p
      ON p.workspace_id = v.workspace_id
     AND p.channel_id   = v.channel_id
    LEFT JOIN video_breakout_fires bf
      ON bf.workspace_id     = v.workspace_id
     AND bf.youtube_video_id = v.youtube_video_id
    WHERE bf.workspace_id IS NULL
      AND v.published_at > (NOW() - (${`${RECENT_PUBLISH_LOOKBACK_DAYS} days`})::interval)
      AND v.velocity_per_hour IS NOT NULL
      AND v.velocity_per_hour > p.p90
    ORDER BY v.velocity_per_hour DESC
    LIMIT ${limit}
  `;

  let fired = 0;
  let errors = 0;

  for (const q of qualifiers) {
    try {
      const hoursSincePublish =
        hoursBetween(q.published_at, new Date().toISOString()) ?? 0;

      // Insert first; UNIQUE catches the duplicate-detection race
      // between two cron ticks. Only emit the event if WE wrote
      // the row (rowCount > 0).
      const ins = await sql`
        INSERT INTO video_breakout_fires (
          workspace_id, youtube_video_id, channel_id,
          velocity_views_per_hour, percentile, channel_p90, hours_since_publish
        ) VALUES (
          ${q.workspace_id}::uuid,
          ${q.youtube_video_id},
          ${q.channel_id}::uuid,
          ${q.velocity_per_hour},
          ${q.percentile},
          ${q.channel_p90},
          ${hoursSincePublish}
        )
        ON CONFLICT (workspace_id, youtube_video_id) DO NOTHING
      `;
      if ((ins.rowCount ?? 0) === 0) continue;

      fired += 1;

      // Phase 9.8.2 — await inline. The previous fire-and-forget
      // `void (async () => ...)()` could drop notifications because
      // Vercel freezes the function after the cron's response
      // promise resolves; pending microtasks may not run.
      try {
        const { dispatchWorkflowEvent } = await import('./workflows');
        const { dispatchWebhookEvent } = await import('./webhooks');
        const safeTitle = q.title ? escapeSlackText(q.title) : null;
        const payload = {
          video_id: q.youtube_video_id,
          channel_db_id: q.channel_id,
          velocity_views_per_hour: Math.round(q.velocity_per_hour * 100) / 100,
          percentile: Math.round(q.percentile * 1000) / 1000,
          channel_p90: Math.round(q.channel_p90 * 100) / 100,
          hours_since_publish: Math.round(hoursSincePublish * 10) / 10,
          title: q.title, // raw title for the workflow trigger payload
        };
        await Promise.allSettled([
          dispatchWorkflowEvent(q.workspace_id, {
            type: 'video_breakout_detected',
            payload,
          }),
          // Webhook detail flows through Slack's mrkdwn; escape user-
          // controlled values so a malicious title can't smuggle in
          // a `<https://attacker/phish|Open Studio>` link.
          dispatchWebhookEvent(q.workspace_id, {
            type: 'video_breakout_detected',
            title: '🚀 Breakout detected',
            detail: `${safeTitle ?? q.youtube_video_id} — ${payload.velocity_views_per_hour}/hr (channel p90: ${payload.channel_p90}/hr)`,
            fields: {
              video_id: payload.video_id,
              channel_db_id: payload.channel_db_id,
              velocity_views_per_hour: payload.velocity_views_per_hour,
              percentile: payload.percentile,
              channel_p90: payload.channel_p90,
              hours_since_publish: payload.hours_since_publish,
              title: safeTitle,
            },
            url: `https://youtu.be/${q.youtube_video_id}`,
          }),
        ]);
      } catch (err) {
        logger.warn('breakout event dispatch failed', {
          workspace_id: q.workspace_id,
          youtube_video_id: q.youtube_video_id,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      errors += 1;
      logger.warn('breakout detector failed for one video', {
        workspace_id: q.workspace_id,
        youtube_video_id: q.youtube_video_id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    scanned: qualifiers.length,
    fired,
    skipped_already_fired: 0, // single query already excludes them
    skipped_no_data: 0, // single query already excludes them
    errors,
  };
}

// ---------------------------------------------------------------------------
// Read API for digest / dashboard
// ---------------------------------------------------------------------------

export interface BreakoutFireRow {
  id: string;
  workspace_id: string;
  youtube_video_id: string;
  channel_id: string | null;
  velocity_views_per_hour: number;
  percentile: number;
  channel_p90: number;
  hours_since_publish: number;
  fired_at: string;
}

export async function listRecentBreakouts(
  workspaceId: string,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<BreakoutFireRow[]> {
  const sinceDays = Math.max(1, opts.sinceDays ?? 14);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const { rows } = await sql<BreakoutFireRow>`
    SELECT
      id, workspace_id, youtube_video_id, channel_id,
      velocity_views_per_hour, percentile, channel_p90, hours_since_publish,
      fired_at::text AS fired_at
    FROM video_breakout_fires
    WHERE workspace_id = ${workspaceId}::uuid
      AND fired_at > (NOW() - (${`${sinceDays} days`})::interval)
    ORDER BY fired_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

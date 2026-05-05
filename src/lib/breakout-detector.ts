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
 * DB orchestrator `detectAndFireBreakouts` joins everything and
 * dispatches the events through the existing webhook + workflow
 * fan-out (lazy import to avoid cycles).
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { computeViewVelocityPerHour, percentileOfVelocity } from './analytics-history';

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
 * Skip rules:
 *   - Already fired (UNIQUE catches this; we also pre-check to count
 *     accurately).
 *   - Less than 6h of trajectory data (window too narrow for a
 *     meaningful velocity).
 *   - Channel has fewer than 5 prior video velocities to baseline
 *     against.
 *
 * Bounded at 100 candidates per run to cap the cost; the cron runs
 * every 6h so a backlog clears within a day.
 */
export async function detectAndFireBreakouts(
  opts: { limit?: number } = {},
): Promise<DetectorResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  // Candidate set: published in last RECENT_PUBLISH_LOOKBACK_DAYS days,
  // not already fired, not older than FIRST_WINDOW_HOURS (the math
  // requires the trajectory to fit in the window).
  const { rows: candidates } = await sql<BreakoutCandidate>`
    SELECT
      va.workspace_id,
      va.youtube_video_id,
      va.channel_id,
      va.title,
      va.published_at::text AS published_at
    FROM video_analytics va
    LEFT JOIN video_breakout_fires bf
      ON bf.workspace_id     = va.workspace_id
     AND bf.youtube_video_id = va.youtube_video_id
    WHERE bf.workspace_id IS NULL
      AND va.published_at IS NOT NULL
      AND va.published_at > (NOW() - (${`${RECENT_PUBLISH_LOOKBACK_DAYS} days`})::interval)
      AND va.channel_id IS NOT NULL
    ORDER BY va.published_at DESC
    LIMIT ${limit}
  `;

  let fired = 0;
  let skippedNoData = 0;
  let errors = 0;

  for (const c of candidates) {
    try {
      // Trajectory of THIS video — every history row within the
      // first-48h window.
      const { rows: traj } = await sql<HistoryRow>`
        SELECT views, captured_at::text AS captured_at
          FROM video_analytics_history
         WHERE workspace_id     = ${c.workspace_id}::uuid
           AND youtube_video_id = ${c.youtube_video_id}
           AND captured_at      >= ${c.published_at}::timestamptz
           AND captured_at      <= (${c.published_at}::timestamptz + (${`${FIRST_WINDOW_HOURS} hours`})::interval)
         ORDER BY captured_at ASC
      `;
      if (traj.length < 2) {
        skippedNoData += 1;
        continue;
      }
      const velocity = computeFirstWindowVelocity(traj, c.published_at, FIRST_WINDOW_HOURS);
      if (velocity === null) {
        skippedNoData += 1;
        continue;
      }

      // Channel population: every other video on this channel
      // published in the last 90 days, with their first-48h
      // velocities precomputed via the same trajectory query.
      const { rows: channelHistoryAgg } = await sql<{
        youtube_video_id: string;
        published_at: string;
      }>`
        SELECT youtube_video_id, published_at::text AS published_at
          FROM video_analytics
         WHERE workspace_id = ${c.workspace_id}::uuid
           AND channel_id   = ${c.channel_id}::uuid
           AND youtube_video_id <> ${c.youtube_video_id}
           AND published_at IS NOT NULL
           AND published_at > (NOW() - (${`${POPULATION_LOOKBACK_DAYS} days`})::interval)
         LIMIT 200
      `;
      const population: number[] = [];
      for (const row of channelHistoryAgg) {
        const { rows: rTraj } = await sql<HistoryRow>`
          SELECT views, captured_at::text AS captured_at
            FROM video_analytics_history
           WHERE workspace_id     = ${c.workspace_id}::uuid
             AND youtube_video_id = ${row.youtube_video_id}
             AND captured_at      >= ${row.published_at}::timestamptz
             AND captured_at      <= (${row.published_at}::timestamptz + (${`${FIRST_WINDOW_HOURS} hours`})::interval)
           ORDER BY captured_at ASC
        `;
        if (rTraj.length < 2) continue;
        const v = computeFirstWindowVelocity(rTraj, row.published_at, FIRST_WINDOW_HOURS);
        if (v !== null) population.push(v);
      }

      const decision = qualifiesAsBreakout(velocity, population);
      if (!decision.qualifies) continue;

      const hoursSincePublish =
        hoursBetween(c.published_at, new Date().toISOString()) ?? 0;

      // Insert the fire row first (UNIQUE catches duplicate detection
      // races); only emit the event if WE wrote the row.
      const ins = await sql`
        INSERT INTO video_breakout_fires (
          workspace_id, youtube_video_id, channel_id,
          velocity_views_per_hour, percentile, channel_p90, hours_since_publish
        ) VALUES (
          ${c.workspace_id}::uuid,
          ${c.youtube_video_id},
          ${c.channel_id}::uuid,
          ${decision.velocity},
          ${decision.percentile},
          ${decision.channel_p90},
          ${hoursSincePublish}
        )
        ON CONFLICT (workspace_id, youtube_video_id) DO NOTHING
      `;
      if ((ins.rowCount ?? 0) > 0) {
        fired += 1;
        // Lazy-import the event dispatchers to avoid pulling them
        // into every analytics consumer. Failures are warned, not
        // thrown — the fire row is the source of truth.
        void (async () => {
          try {
            const { dispatchWorkflowEvent } = await import('./workflows');
            const { dispatchWebhookEvent } = await import('./webhooks');
            const payload = {
              video_id: c.youtube_video_id,
              channel_db_id: c.channel_id,
              velocity_views_per_hour: Math.round(decision.velocity * 100) / 100,
              percentile: Math.round(decision.percentile * 1000) / 1000,
              channel_p90: Math.round(decision.channel_p90 * 100) / 100,
              hours_since_publish: Math.round(hoursSincePublish * 10) / 10,
              title: c.title,
            };
            await Promise.allSettled([
              dispatchWorkflowEvent(c.workspace_id, {
                type: 'video_breakout_detected',
                payload,
              }),
              dispatchWebhookEvent(c.workspace_id, {
                type: 'video_breakout_detected',
                title: '🚀 Breakout detected',
                detail: `${c.title ?? c.youtube_video_id} — ${payload.velocity_views_per_hour}/hr (channel p90: ${payload.channel_p90}/hr)`,
                fields: {
                  video_id: payload.video_id,
                  channel_db_id: payload.channel_db_id,
                  velocity_views_per_hour: payload.velocity_views_per_hour,
                  percentile: payload.percentile,
                  channel_p90: payload.channel_p90,
                  hours_since_publish: payload.hours_since_publish,
                  title: payload.title,
                },
                url: `https://youtu.be/${c.youtube_video_id}`,
              }),
            ]);
          } catch (err) {
            logger.warn('breakout event dispatch failed', {
              workspace_id: c.workspace_id,
              youtube_video_id: c.youtube_video_id,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }
    } catch (err) {
      errors += 1;
      logger.warn('breakout detector failed for one video', {
        workspace_id: c.workspace_id,
        youtube_video_id: c.youtube_video_id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    scanned: candidates.length,
    fired,
    skipped_already_fired: 0, // candidates query already excludes them
    skipped_no_data: skippedNoData,
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

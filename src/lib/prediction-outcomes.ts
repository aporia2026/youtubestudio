/**
 * Phase 8.5 — post-publish prediction outcomes.
 *
 * The retention predictor (Phase 4.2) forecasts a curve before publish.
 * After the video has been live ≥14 days, YouTube reports the *actual*
 * retention curve. This module captures the (predicted, actual, delta)
 * tuple into `prediction_outcomes` so two things can happen:
 *
 *   1. The predictor's few-shot RAG can prefer outcome rows over raw
 *      analytics rows — the LLM sees not just "this is what the curve
 *      looked like" but "we predicted X, reality was Y". That's strictly
 *      more signal and is what makes the predictor sharper on this
 *      channel over time.
 *   2. The dashboard can show aggregate accuracy: "your script hooks
 *      are getting better; midroll retention is getting worse over the
 *      last 30 days" — derived from the per-segment delta history.
 *
 * Pure helpers (`computeDeltaMetrics`, `interpolateCurve`,
 * `aggregateAccuracy`) are exported for unit tests so the math stays
 * honest as the dataset grows. DB wrappers do the capture work + the
 * few-shot retrieval that replaces the predictor's raw-analytics path.
 *
 * Linking model: retention_prediction → project_id → published_videos
 * (status='live') → youtube_video_id → video_analytics. A single project
 * can have multiple predictions (the user iterated on the script);
 * each is captured as its own outcome row, all pointing at the same
 * actual curve. The UNIQUE (workspace_id, retention_prediction_id)
 * constraint keeps the cron idempotent.
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { normalizeCurve } from './retention-curve-utils';
import type { RetentionPoint } from './retention-predictor-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PerSegmentDelta {
  /** 0-1 fractional position through the video. */
  position: number;
  /** 0-1 predicted retention at this position. */
  predicted: number;
  /** 0-1 actual retention at this position. */
  actual: number;
  /** actual - predicted, in 0-1 units. Positive = we *underpredicted*
   *  (audience held longer than we forecast). Negative = we
   *  *overpredicted* (audience dropped faster than we forecast). */
  delta: number;
}

export type MissDirection = 'over' | 'under' | 'none';

export interface DeltaMetrics {
  /** Mean absolute error across the sampled positions, in percentage
   *  points (0-100). 5.2 means we were off by 5.2pp on average. */
  mae_pct: number;
  /** Position (0-1) where the absolute error was largest. */
  biggest_miss_at_pct: number;
  /** Sign of the biggest miss. 'over' = predicted too high, 'under' =
   *  predicted too low, 'none' = perfect (rare). */
  biggest_miss_direction: MissDirection;
  /** Sample-by-sample comparison at fixed evenly-spaced positions. */
  per_segment_deltas: PerSegmentDelta[];
}

export interface PredictionOutcomeRow {
  id: string;
  workspace_id: string;
  retention_prediction_id: string;
  youtube_video_id: string;
  predicted_curve: RetentionPoint[];
  actual_curve: RetentionPoint[];
  delta_metrics: DeltaMetrics;
  captured_at: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Number of evenly-spaced positions we sample both curves at when
 *  computing the per-segment delta. 11 points = 0.0, 0.1, ..., 1.0. */
const SEGMENT_SAMPLE_COUNT = 11;

/**
 * Linear-interpolate a sorted retention curve at an arbitrary 0-1
 * position. Used so we can compare predicted and actual curves at the
 * same positions even when their sample densities differ.
 *
 * Returns the nearest endpoint when the requested position is outside
 * the curve's domain (clamped, no extrapolation — extrapolation past
 * the curve would produce nonsense).
 *
 * Returns null for an empty curve.
 */
export function interpolateCurve(curve: RetentionPoint[], position: number): number | null {
  if (curve.length === 0) return null;
  if (curve.length === 1) return curve[0]!.retention;
  const p = Math.max(0, Math.min(1, position));

  // Curve is sorted ascending by position (normalizeCurve guarantees this).
  if (p <= curve[0]!.position) return curve[0]!.retention;
  if (p >= curve[curve.length - 1]!.position) return curve[curve.length - 1]!.retention;

  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    if (p >= a.position && p <= b.position) {
      const span = b.position - a.position;
      if (span === 0) return a.retention;
      const t = (p - a.position) / span;
      return a.retention + t * (b.retention - a.retention);
    }
  }
  // Unreachable if curve is sorted, but guard.
  return curve[curve.length - 1]!.retention;
}

/**
 * Compute the delta metrics for a (predicted, actual) curve pair.
 * Pure — no DB or network. Returns sane defaults when one of the
 * curves is degenerate (the cron's preconditions filter these out
 * before calling, but defence in depth).
 */
export function computeDeltaMetrics(
  predicted: RetentionPoint[],
  actual: RetentionPoint[],
): DeltaMetrics {
  // Both must have at least 2 points for interpolation to have any
  // meaning. Anything sparser collapses to "we have no idea" — emit
  // a zero-filled metric rather than throwing so the cron doesn't
  // halt on one bad row.
  if (predicted.length < 2 || actual.length < 2) {
    return {
      mae_pct: 0,
      biggest_miss_at_pct: 0,
      biggest_miss_direction: 'none',
      per_segment_deltas: [],
    };
  }

  const segments: PerSegmentDelta[] = [];
  let absSum = 0;
  let biggestAbsMiss = 0;
  let biggestSignedMiss = 0;
  let biggestMissAt = 0;

  for (let i = 0; i < SEGMENT_SAMPLE_COUNT; i++) {
    const position = i / (SEGMENT_SAMPLE_COUNT - 1);
    const pred = interpolateCurve(predicted, position) ?? 0;
    const act = interpolateCurve(actual, position) ?? 0;
    const delta = act - pred;
    segments.push({
      position: round3(position),
      predicted: round3(pred),
      actual: round3(act),
      delta: round3(delta),
    });
    const abs = Math.abs(delta);
    absSum += abs;
    if (abs > biggestAbsMiss) {
      biggestAbsMiss = abs;
      biggestSignedMiss = delta;
      biggestMissAt = position;
    }
  }

  const maePct = (absSum / SEGMENT_SAMPLE_COUNT) * 100;

  let direction: MissDirection;
  if (biggestAbsMiss < 1e-6) {
    direction = 'none';
  } else if (biggestSignedMiss < 0) {
    // actual < predicted → we predicted too high → 'over'
    direction = 'over';
  } else {
    direction = 'under';
  }

  return {
    mae_pct: round3(maePct),
    biggest_miss_at_pct: round3(biggestMissAt),
    biggest_miss_direction: direction,
    per_segment_deltas: segments,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Aggregations for the dashboard accuracy card
// ---------------------------------------------------------------------------

/** Semantic buckets the dashboard rolls per-segment deltas into. The
 *  ranges intentionally overlap with how the predictor's segment
 *  explanations talk about a video (hook / early / midroll / outro). */
export const ACCURACY_BUCKETS = [
  { key: 'hook', label: 'Hook', from: 0.0, to: 0.15 },
  { key: 'early', label: 'Early', from: 0.15, to: 0.35 },
  { key: 'midroll', label: 'Midroll', from: 0.35, to: 0.65 },
  { key: 'outro', label: 'Outro', from: 0.65, to: 1.0 },
] as const;

export type AccuracyBucketKey = (typeof ACCURACY_BUCKETS)[number]['key'];

export interface AccuracyBucketStat {
  key: AccuracyBucketKey;
  label: string;
  /** Mean absolute error in percentage points across the bucket (averaged
   *  across all outcomes' samples that fall in [from, to]). */
  mae_pct: number;
  /** Mean signed error in percentage points. Negative = we systematically
   *  predict too high here. Positive = we systematically predict too low. */
  bias_pct: number;
  /** Number of outcome rows that contributed at least one sample. */
  outcome_count: number;
}

export interface AccuracyTrendBucket {
  key: AccuracyBucketKey;
  label: string;
  /** MAE for outcomes captured in the more-recent half of the window. */
  recent_mae_pct: number;
  /** MAE for outcomes captured in the older half of the window. */
  older_mae_pct: number;
  /** recent - older, in percentage points. Negative = improving
   *  (error shrinking). Positive = getting worse. Null when one of
   *  the halves had no outcomes. */
  delta_pct: number | null;
}

export interface PredictionAccuracySummary {
  outcome_count: number;
  /** Mean of every outcome's `mae_pct`, in percentage points. */
  overall_mae_pct: number | null;
  buckets: AccuracyBucketStat[];
  /** Same buckets, but split into "older half" vs "newer half" of the
   *  window so the UI can call out improving / regressing segments. */
  trend: AccuracyTrendBucket[];
  /** ISO timestamp of the most recent outcome captured. Null when none. */
  last_captured_at: string | null;
}

/** Aggregate raw outcomes (in time-descending order) into the
 *  dashboard-shaped summary. Pure. */
export function aggregateAccuracy(
  outcomes: Array<{ delta_metrics: DeltaMetrics; captured_at: string }>,
): PredictionAccuracySummary {
  if (outcomes.length === 0) {
    return {
      outcome_count: 0,
      overall_mae_pct: null,
      buckets: ACCURACY_BUCKETS.map((b) => ({
        key: b.key,
        label: b.label,
        mae_pct: 0,
        bias_pct: 0,
        outcome_count: 0,
      })),
      trend: ACCURACY_BUCKETS.map((b) => ({
        key: b.key,
        label: b.label,
        recent_mae_pct: 0,
        older_mae_pct: 0,
        delta_pct: null,
      })),
      last_captured_at: null,
    };
  }

  const overallMae =
    outcomes.reduce((sum, o) => sum + (o.delta_metrics.mae_pct || 0), 0) / outcomes.length;

  const buckets: AccuracyBucketStat[] = ACCURACY_BUCKETS.map((b) => {
    let absSum = 0;
    let signedSum = 0;
    let count = 0;
    let outcomesContributing = 0;
    for (const o of outcomes) {
      let contributed = false;
      for (const seg of o.delta_metrics.per_segment_deltas) {
        if (seg.position >= b.from && seg.position <= b.to) {
          absSum += Math.abs(seg.delta);
          signedSum += seg.delta;
          count += 1;
          contributed = true;
        }
      }
      if (contributed) outcomesContributing += 1;
    }
    return {
      key: b.key,
      label: b.label,
      mae_pct: count === 0 ? 0 : round3((absSum / count) * 100),
      bias_pct: count === 0 ? 0 : round3((signedSum / count) * 100),
      outcome_count: outcomesContributing,
    };
  });

  // Trend: sort by captured_at, split in half, compute MAE per half per
  // bucket. Caller passes outcomes in any order — sort defensively.
  const sortedAsc = [...outcomes].sort((a, b) =>
    a.captured_at.localeCompare(b.captured_at),
  );
  const mid = Math.floor(sortedAsc.length / 2);
  const olderHalf = sortedAsc.slice(0, mid);
  const recentHalf = sortedAsc.slice(mid);

  const trend: AccuracyTrendBucket[] = ACCURACY_BUCKETS.map((b) => {
    const olderMae = bucketMae(olderHalf, b.from, b.to);
    const recentMae = bucketMae(recentHalf, b.from, b.to);
    const delta =
      olderMae === null || recentMae === null ? null : round3(recentMae - olderMae);
    return {
      key: b.key,
      label: b.label,
      older_mae_pct: olderMae ?? 0,
      recent_mae_pct: recentMae ?? 0,
      delta_pct: delta,
    };
  });

  // Outcomes were passed in arbitrary order; the most recent
  // captured_at is the max, not necessarily the first.
  const lastCapturedAt = outcomes
    .map((o) => o.captured_at)
    .reduce((a, b) => (a > b ? a : b));

  return {
    outcome_count: outcomes.length,
    overall_mae_pct: round3(overallMae),
    buckets,
    trend,
    last_captured_at: lastCapturedAt,
  };
}

function bucketMae(
  outcomes: Array<{ delta_metrics: DeltaMetrics }>,
  from: number,
  to: number,
): number | null {
  let absSum = 0;
  let count = 0;
  for (const o of outcomes) {
    for (const seg of o.delta_metrics.per_segment_deltas) {
      if (seg.position >= from && seg.position <= to) {
        absSum += Math.abs(seg.delta);
        count += 1;
      }
    }
  }
  if (count === 0) return null;
  return round3((absSum / count) * 100);
}

// ---------------------------------------------------------------------------
// Capture cron — finds (prediction, video_analytics) pairs and stores deltas
// ---------------------------------------------------------------------------

interface CaptureCandidate {
  prediction_id: string;
  workspace_id: string;
  predicted_curve: unknown;
  youtube_video_id: string;
  actual_curve: unknown;
}

export interface CaptureResult {
  scanned: number;
  inserted: number;
  skipped: number;
  errors: number;
}

/**
 * Find every prediction whose video has been live ≥ minDaysLive AND
 * doesn't yet have a captured outcome, and INSERT one outcome row per
 * pair. Idempotent — re-running on the same data is a no-op because of
 * the UNIQUE (workspace_id, retention_prediction_id) constraint and the
 * NOT EXISTS gate in the query.
 *
 * The link path is:
 *   retention_predictions.project_id
 *     → published_videos (status='live', same project_id, same workspace)
 *     → published_videos.youtube_video_id
 *     → video_analytics (same workspace_id + youtube_video_id)
 *
 * Predictions without a project_id (ad-hoc /retention scratch runs) are
 * skipped — there's no way to attribute them to a published video.
 *
 * Phase 8.6.2 — only PRE-PUBLISH predictions are captured. Without
 * the `rp.created_at < pv.created_at` clause, a user who runs
 * /retention against a script *after* uploading would have that
 * hindsight prediction captured as if it informed the upload, and the
 * model would learn from a "miss" with cheating context. Filter it
 * out here so the training signal stays clean.
 */
export async function captureOutcomesForReadyVideos(
  opts: { minDaysLive?: number; limit?: number } = {},
): Promise<CaptureResult> {
  const minDaysLive = Math.max(1, opts.minDaysLive ?? 14);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);

  const { rows: candidates } = await sql<CaptureCandidate>`
    SELECT
      rp.id   AS prediction_id,
      rp.workspace_id,
      rp.predicted_curve,
      pv.youtube_video_id,
      va.retention_curve AS actual_curve
    FROM retention_predictions rp
    JOIN published_videos pv
      ON pv.workspace_id = rp.workspace_id
     AND pv.project_id   = rp.project_id
     AND pv.status       = 'live'
     AND pv.youtube_video_id IS NOT NULL
    JOIN video_analytics va
      ON va.workspace_id      = rp.workspace_id
     AND va.youtube_video_id  = pv.youtube_video_id
    WHERE rp.project_id IS NOT NULL
      AND rp.created_at < pv.created_at
      AND va.retention_curve IS NOT NULL
      AND jsonb_array_length(va.retention_curve) > 5
      AND va.published_at IS NOT NULL
      AND va.published_at < (NOW() - (${`${minDaysLive} days`})::interval)
      AND NOT EXISTS (
        SELECT 1 FROM prediction_outcomes po
         WHERE po.workspace_id            = rp.workspace_id
           AND po.retention_prediction_id = rp.id
      )
    ORDER BY va.published_at ASC
    LIMIT ${limit}
  `;

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const c of candidates) {
    try {
      const predicted = normalizeCurve(c.predicted_curve);
      const actual = normalizeCurve(c.actual_curve);
      if (predicted.length < 2 || actual.length < 2) {
        skipped += 1;
        continue;
      }
      const metrics = computeDeltaMetrics(predicted, actual);

      // ON CONFLICT DO NOTHING handles the rare race where two cron
      // invocations overlap and pick the same row before either INSERT
      // commits. The NOT EXISTS in the SELECT keeps the steady-state
      // case efficient (no wasted INSERT attempts).
      const result = await sql`
        INSERT INTO prediction_outcomes (
          workspace_id, retention_prediction_id, youtube_video_id,
          predicted_curve, actual_curve, delta_metrics
        ) VALUES (
          ${c.workspace_id}::uuid,
          ${c.prediction_id}::uuid,
          ${c.youtube_video_id},
          ${JSON.stringify(predicted)}::jsonb,
          ${JSON.stringify(actual)}::jsonb,
          ${JSON.stringify(metrics)}::jsonb
        )
        ON CONFLICT (workspace_id, retention_prediction_id) DO NOTHING
      `;
      if ((result.rowCount ?? 0) > 0) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    } catch (err) {
      errors += 1;
      logger.error('prediction-outcomes capture failed for one row', {
        prediction_id: c.prediction_id,
        youtube_video_id: c.youtube_video_id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: candidates.length, inserted, skipped, errors };
}

// ---------------------------------------------------------------------------
// Few-shot retrieval — outcome-aware replacement for the predictor's
// findFewShotExamples
// ---------------------------------------------------------------------------

/** Outcome-augmented few-shot row. Carries the predicted curve + delta
 *  alongside the actual curve so the predictor can show the model not
 *  just "this is what happened" but "we predicted X and reality was Y".
 *  Compatible with the existing FewShotExample shape (the predictor's
 *  prompt builder reads the same fields). */
export interface OutcomeFewShotExample {
  youtube_video_id: string;
  title: string | null;
  duration_seconds: number | null;
  /** The actual retention curve from video_analytics. Same shape as the
   *  predictor's existing FewShotExample.retention_curve. */
  retention_curve: RetentionPoint[];
  /** Snapshot of the predicted curve from the original prediction. */
  predicted_curve: RetentionPoint[];
  /** Delta metrics computed at capture time. */
  delta_metrics: DeltaMetrics;
}

interface RawOutcomeRow {
  youtube_video_id: string;
  title: string | null;
  duration_seconds: number | null;
  predicted_curve: unknown;
  actual_curve: unknown;
  delta_metrics: unknown;
}

/**
 * Pull the most-recent outcome rows for this workspace (optionally
 * scoped to a single channel). Used by `predictRetention` in place of
 * raw `video_analytics` rows when outcomes exist — the model gets
 * strictly more signal that way (predicted + actual + delta vs actual
 * only).
 *
 * Returns [] when no outcomes exist; the caller falls back to the
 * raw-analytics path so the predictor still works on a cold-start
 * workspace.
 */
export async function findFewShotOutcomes(opts: {
  workspaceId: string;
  channelDbId?: string | null;
  limit?: number;
}): Promise<OutcomeFewShotExample[]> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);

  // The channel filter goes through video_analytics.channel_id rather
  // than retention_predictions.channel_db_id so we get the channel
  // that actually published the video, not the channel the prediction
  // was scoped to (these can differ in edge cases).
  //
  // Phase 8.6.2 — DISTINCT ON (po.youtube_video_id) keeps the most
  // recent outcome per video. Without this, a project with 3 prediction
  // iterations could fill all 3 of MAX_FEW_SHOT_EXAMPLES with the same
  // actual curve (different predicted curves) — burning prompt tokens
  // for no extra signal. Diversity > iteration history at this stage.
  const rows: RawOutcomeRow[] = opts.channelDbId
    ? (
        await sql<RawOutcomeRow>`
          SELECT DISTINCT ON (po.youtube_video_id)
            po.youtube_video_id,
            va.title,
            va.duration_seconds,
            po.predicted_curve,
            po.actual_curve,
            po.delta_metrics,
            po.captured_at
          FROM prediction_outcomes po
          JOIN video_analytics va
            ON va.workspace_id     = po.workspace_id
           AND va.youtube_video_id = po.youtube_video_id
          WHERE po.workspace_id = ${opts.workspaceId}::uuid
            AND va.channel_id   = ${opts.channelDbId}::uuid
          ORDER BY po.youtube_video_id, po.captured_at DESC
          LIMIT ${limit}
        `
      ).rows
    : (
        await sql<RawOutcomeRow>`
          SELECT DISTINCT ON (po.youtube_video_id)
            po.youtube_video_id,
            va.title,
            va.duration_seconds,
            po.predicted_curve,
            po.actual_curve,
            po.delta_metrics,
            po.captured_at
          FROM prediction_outcomes po
          JOIN video_analytics va
            ON va.workspace_id     = po.workspace_id
           AND va.youtube_video_id = po.youtube_video_id
          WHERE po.workspace_id = ${opts.workspaceId}::uuid
          ORDER BY po.youtube_video_id, po.captured_at DESC
          LIMIT ${limit}
        `
      ).rows;

  return rows
    .map((r) => {
      const actual = normalizeCurve(r.actual_curve);
      const predicted = normalizeCurve(r.predicted_curve);
      if (actual.length < 6) return null;
      const metrics = parseDeltaMetrics(r.delta_metrics);
      return {
        youtube_video_id: r.youtube_video_id,
        title: r.title,
        duration_seconds: r.duration_seconds,
        retention_curve: actual,
        predicted_curve: predicted,
        delta_metrics: metrics,
      } satisfies OutcomeFewShotExample;
    })
    .filter((x): x is OutcomeFewShotExample => x !== null);
}

// Phase 8.6.2 — defensive parser that re-clamps stored JSONB to the
// invariants `computeDeltaMetrics` produces. Catches any garbage that
// a future migration / hand-fix could introduce (negative MAE,
// position > 1, NaN deltas) before the dashboard renders it.
//
// Exported for unit testing — no production caller outside this file.
export function parseDeltaMetrics(raw: unknown): DeltaMetrics {
  if (!raw || typeof raw !== 'object') {
    return {
      mae_pct: 0,
      biggest_miss_at_pct: 0,
      biggest_miss_direction: 'none',
      per_segment_deltas: [],
    };
  }
  const o = raw as Record<string, unknown>;
  const direction = o.biggest_miss_direction;
  return {
    mae_pct: clamp(asNumber(o.mae_pct), 0, 100),
    biggest_miss_at_pct: clamp(asNumber(o.biggest_miss_at_pct), 0, 1),
    biggest_miss_direction:
      direction === 'over' || direction === 'under' || direction === 'none'
        ? direction
        : 'none',
    per_segment_deltas: Array.isArray(o.per_segment_deltas)
      ? o.per_segment_deltas
          .filter(
            (s): s is PerSegmentDelta =>
              !!s &&
              typeof s === 'object' &&
              typeof (s as PerSegmentDelta).position === 'number' &&
              typeof (s as PerSegmentDelta).predicted === 'number' &&
              typeof (s as PerSegmentDelta).actual === 'number' &&
              typeof (s as PerSegmentDelta).delta === 'number',
          )
          .map((s) => ({
            position: clamp(s.position, 0, 1),
            predicted: clamp(s.predicted, 0, 1),
            actual: clamp(s.actual, 0, 1),
            // delta = actual - predicted, so its range is [-1, 1].
            delta: clamp(s.delta, -1, 1),
          }))
      : [],
  };
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------------
// Dashboard read API
// ---------------------------------------------------------------------------

/** Pull the workspace's recent outcomes and aggregate them into the
 *  shape the PredictionAccuracyCard renders. */
export async function getPredictionAccuracySummary(opts: {
  workspaceId: string;
  lookbackDays?: number;
}): Promise<PredictionAccuracySummary> {
  const lookbackDays = Math.max(1, opts.lookbackDays ?? 30);
  const { rows } = await sql<{ delta_metrics: DeltaMetrics; captured_at: string }>`
    SELECT delta_metrics, captured_at::text AS captured_at
      FROM prediction_outcomes
     WHERE workspace_id = ${opts.workspaceId}::uuid
       AND captured_at > (NOW() - (${`${lookbackDays} days`})::interval)
     ORDER BY captured_at DESC
     LIMIT 500
  `;
  return aggregateAccuracy(
    rows.map((r) => ({
      delta_metrics: parseDeltaMetrics(r.delta_metrics),
      captured_at: r.captured_at,
    })),
  );
}

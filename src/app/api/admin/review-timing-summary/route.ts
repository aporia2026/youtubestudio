import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';

/**
 * GET /api/admin/review-timing-summary?days=7
 *
 * Aggregates the rolling window of review-player timing samples
 * (`review_player_timing_samples`, migration 0069) and returns the
 * percentile numbers needed for the HLS Phase 2 greenlight/skip
 * decision — see `_plans/2026-05-14-review-timing-aggregation.md`.
 *
 * Split by `was_owner` so the owner's fast connection doesn't skew the
 * reviewer-side numbers that actually drive the decision.
 *
 * Verdict logic encoded server-side so the threshold lives in one place:
 *
 *   - insufficient-samples : reviewer-side n < 30
 *   - skip-hls             : reviewer-side p50_ttff < 2.5s AND p95_ttff < 8s
 *   - greenlight-hls       : reviewer-side p50_ttff ≥ 2.5s OR p95_ttff ≥ 8s
 *                            AND high stall ratio (suggests network, not server)
 *   - investigate          : breached thresholds but low stall ratio
 *                            (likely a server-side bottleneck, HLS won't help)
 */

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const MIN_REVIEWER_SAMPLES = 30;
const P50_TTFF_THRESHOLD_MS = 2_500;
const P95_TTFF_THRESHOLD_MS = 8_000;
// "High stall ratio" = at least 1 stall per 5 sessions on average. Below
// that, slow first-frame is usually server-side (R2 latency, byte-range
// inefficiency) which HLS doesn't fix.
const STALL_RATIO_FOR_HLS = 0.2;

interface PercentileRow {
  samples: number;
  p50_ttff_ms: number | null;
  p95_ttff_ms: number | null;
  p50_tcpt_ms: number | null;
  p95_tcpt_ms: number | null;
  p95_total_stall_ms: number | null;
  mean_stall_count: number | null;
}

type Verdict = 'skip-hls' | 'greenlight-hls' | 'investigate' | 'insufficient-samples';

function computeVerdict(reviewer: PercentileRow): Verdict {
  if (reviewer.samples < MIN_REVIEWER_SAMPLES) return 'insufficient-samples';
  const p50 = reviewer.p50_ttff_ms ?? 0;
  const p95 = reviewer.p95_ttff_ms ?? 0;
  const stallRatio = (reviewer.mean_stall_count ?? 0);
  const breached = p50 >= P50_TTFF_THRESHOLD_MS || p95 >= P95_TTFF_THRESHOLD_MS;
  if (!breached) return 'skip-hls';
  return stallRatio >= STALL_RATIO_FOR_HLS ? 'greenlight-hls' : 'investigate';
}

async function queryPercentiles(days: number, wasOwner: boolean): Promise<PercentileRow> {
  // percentile_cont returns DOUBLE PRECISION; cast to INTEGER ms so the
  // response stays tidy. AVG(stall_count) stays as float so the
  // "0.2 stalls per session" thresholds work without rounding-to-zero.
  const { rows } = await sql<{
    samples: number;
    p50_ttff_ms: number | null;
    p95_ttff_ms: number | null;
    p50_tcpt_ms: number | null;
    p95_tcpt_ms: number | null;
    p95_total_stall_ms: number | null;
    mean_stall_count: number | null;
  }>`
    SELECT
      COUNT(*)::int AS samples,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY time_to_first_frame_ms)::int     AS p50_ttff_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY time_to_first_frame_ms)::int     AS p95_ttff_ms,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY time_to_canplaythrough_ms)::int  AS p50_tcpt_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY time_to_canplaythrough_ms)::int  AS p95_tcpt_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY total_stall_ms)::int             AS p95_total_stall_ms,
      AVG(stall_count)::float                                                       AS mean_stall_count
    FROM review_player_timing_samples
    WHERE created_at >= NOW() - (${days}::int * INTERVAL '1 day')
      AND was_owner = ${wasOwner}
  `;
  const r = rows[0];
  return {
    samples: Number(r?.samples ?? 0),
    p50_ttff_ms: r?.p50_ttff_ms ?? null,
    p95_ttff_ms: r?.p95_ttff_ms ?? null,
    p50_tcpt_ms: r?.p50_tcpt_ms ?? null,
    p95_tcpt_ms: r?.p95_tcpt_ms ?? null,
    p95_total_stall_ms: r?.p95_total_stall_ms ?? null,
    mean_stall_count: r?.mean_stall_count ?? null,
  };
}

export const GET = apiRoute.admin(async (_session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const daysParam = Number.parseInt(searchParams.get('days') ?? String(DEFAULT_DAYS), 10);
  const days = Number.isFinite(daysParam)
    ? Math.max(MIN_DAYS, Math.min(MAX_DAYS, daysParam))
    : DEFAULT_DAYS;

  const [reviewer, owner] = await Promise.all([
    queryPercentiles(days, false),
    queryPercentiles(days, true),
  ]);

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  return NextResponse.json({
    window: { days, from: from.toISOString(), to: now.toISOString() },
    total_samples: reviewer.samples + owner.samples,
    by_was_owner: {
      reviewer,
      owner,
    },
    thresholds: {
      p50_ttff_ms: P50_TTFF_THRESHOLD_MS,
      p95_ttff_ms: P95_TTFF_THRESHOLD_MS,
      min_reviewer_samples: MIN_REVIEWER_SAMPLES,
      stall_ratio_for_hls: STALL_RATIO_FOR_HLS,
    },
    verdict: computeVerdict(reviewer),
  });
});

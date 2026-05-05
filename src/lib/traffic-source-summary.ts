/**
 * Phase 9.2 — workspace-level aggregation of per-video traffic-source
 * breakdowns. Drives the dashboard card that says "Suggested-feed share
 * is up 12% vs last month" — a single channel-health signal.
 *
 * Pure helpers (`mergeBreakdowns`, `breakdownDelta`) are exported for
 * unit testing. The DB read fans both queries in parallel because the
 * two windows are independent.
 */
import { sql } from '@vercel/postgres';
import type { TrafficSourceBreakdown } from './youtube-analytics';
import { trafficSourcePercentages } from './youtube-analytics';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrafficSourceSummary {
  /** Number of videos that contributed to the recent window (≥ 1
   *  required for the card to render). */
  recent_video_count: number;
  /** Same for the comparison window. */
  prior_video_count: number;
  /** Recent-window absolute view counts per source. Empty when no
   *  videos contributed. */
  recent_breakdown: TrafficSourceBreakdown;
  /** Recent-window percentage shares. */
  recent_pct: Record<string, number>;
  /** Prior-window percentage shares (so the dashboard can show the
   *  baseline alongside the delta). */
  prior_pct: Record<string, number>;
  /** Per-source `recent_pct - prior_pct` in percentage points. Positive
   *  = source's share grew. Sorted by descending absolute delta so
   *  the dashboard can surface the biggest mover first. */
  deltas: Array<{ source: string; delta_pct: number }>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Sum a list of per-video breakdowns into a workspace-level aggregate.
 * Skips null entries (videos that never got a sync). Pure: no DB.
 */
export function mergeBreakdowns(
  rows: Array<TrafficSourceBreakdown | null>,
): TrafficSourceBreakdown {
  const out: TrafficSourceBreakdown = {};
  for (const r of rows) {
    if (!r) continue;
    for (const [src, count] of Object.entries(r)) {
      if (!Number.isFinite(count)) continue;
      out[src] = (out[src] ?? 0) + count;
    }
  }
  return out;
}

/**
 * Per-source delta between two percentage maps. Returns the union of
 * keys (a source missing from one side counts as 0%) sorted by
 * descending absolute delta — the dashboard surfaces the biggest
 * mover first.
 */
export function breakdownDelta(
  recentPct: Record<string, number>,
  priorPct: Record<string, number>,
): Array<{ source: string; delta_pct: number }> {
  const keys = new Set([...Object.keys(recentPct), ...Object.keys(priorPct)]);
  const out = [...keys].map((source) => ({
    source,
    delta_pct: (recentPct[source] ?? 0) - (priorPct[source] ?? 0),
  }));
  out.sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct));
  return out;
}

// ---------------------------------------------------------------------------
// DB read
// ---------------------------------------------------------------------------

/**
 * Pull traffic-source breakdowns for the workspace's recently-published
 * videos. Default windows: "recent" = last 30 days, "prior" = the 30
 * days before that. Channel-scoped when channelDbId is provided.
 *
 * The read is deliberately split into two parallel SELECTs so each
 * uses the existing `(workspace_id, channel_id, published_at)` index
 * cleanly without a CASE-WHEN gymnastics that the planner can't
 * always optimise.
 */
export async function getTrafficSourceSummary(opts: {
  workspaceId: string;
  channelDbId?: string | null;
  recentWindowDays?: number;
}): Promise<TrafficSourceSummary> {
  const recentDays = Math.max(1, opts.recentWindowDays ?? 30);
  const channelDbId = opts.channelDbId ?? null;

  const fetchWindow = async (
    fromDaysAgo: number,
    toDaysAgo: number,
  ): Promise<Array<{ traffic_source_breakdown: TrafficSourceBreakdown | null }>> => {
    const { rows } = await sql<{ traffic_source_breakdown: TrafficSourceBreakdown | null }>`
      SELECT traffic_source_breakdown
        FROM video_analytics
       WHERE workspace_id = ${opts.workspaceId}::uuid
         AND traffic_source_breakdown IS NOT NULL
         AND published_at IS NOT NULL
         AND published_at < (NOW() - (${`${toDaysAgo} days`})::interval)
         AND published_at > (NOW() - (${`${fromDaysAgo} days`})::interval)
         AND (${channelDbId}::uuid IS NULL OR channel_id = ${channelDbId}::uuid)
    `;
    return rows;
  };

  const [recentRows, priorRows] = await Promise.all([
    fetchWindow(recentDays, 0),
    fetchWindow(recentDays * 2, recentDays),
  ]);

  const recentBreakdown = mergeBreakdowns(
    recentRows.map((r) => r.traffic_source_breakdown),
  );
  const priorBreakdown = mergeBreakdowns(
    priorRows.map((r) => r.traffic_source_breakdown),
  );
  const recentPct = trafficSourcePercentages(recentBreakdown);
  const priorPct = trafficSourcePercentages(priorBreakdown);

  return {
    recent_video_count: recentRows.length,
    prior_video_count: priorRows.length,
    recent_breakdown: recentBreakdown,
    recent_pct: recentPct,
    prior_pct: priorPct,
    deltas: breakdownDelta(recentPct, priorPct),
  };
}

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  getCompetitorSignals,
  listCompetitorSummaries,
  listRecentBreakouts,
} from '@/lib/competitor-summary';

/**
 * GET /api/competitors/summary
 *
 * Returns:
 *   - signals: compact card-shaped data for the main dashboard
 *   - channels: per-competitor cadence + momentum
 *   - breakouts: top recent video breakouts (last 14d, ≥ 2.5× median)
 *
 * One round-trip so the /competitors/dashboard page paints fast.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const lookback = Number.parseInt(searchParams.get('lookbackDays') ?? '14', 10) || 14;
  const minVs = Number.parseFloat(searchParams.get('minVsMedian') ?? '2.5') || 2.5;

  const [signals, channels, breakouts] = await Promise.all([
    getCompetitorSignals(session.ws),
    listCompetitorSummaries(session.ws),
    listRecentBreakouts(session.ws, { lookbackDays: lookback, minVsMedian: minVs, limit: 25 }),
  ]);
  return NextResponse.json({ signals, channels, breakouts });
});

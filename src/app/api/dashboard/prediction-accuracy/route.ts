import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getPredictionAccuracySummary } from '@/lib/prediction-outcomes';

/**
 * GET /api/dashboard/prediction-accuracy
 *
 * Phase 8.5 — feeds the dashboard's PredictionAccuracyCard. Pulls the
 * workspace's outcomes from the last `lookbackDays` (default 30),
 * aggregates per semantic bucket (hook / early / midroll / outro), and
 * returns a trend split (older half vs recent half) so the card can call
 * out improving / regressing segments.
 */
export const GET = apiRoute.authed(async (session, req) => {
  const url = new URL(req.url);
  const raw = url.searchParams.get('lookbackDays');
  const lookback = raw ? Math.max(1, Math.min(180, Number(raw))) : 30;
  const summary = await getPredictionAccuracySummary({
    workspaceId: session.ws,
    lookbackDays: Number.isFinite(lookback) ? lookback : 30,
  });
  return NextResponse.json(summary);
});

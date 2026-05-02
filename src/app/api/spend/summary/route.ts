import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { summarizeSpend } from '@/lib/ai-spend';

/**
 * GET /api/spend/summary?windowDays=30
 *
 * Workspace-scoped AI spend summary across the last N days. Returns
 * totals + per-feature + per-model + per-project + per-day arrays
 * + the 10 most expensive individual calls.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const windowDays = Number.parseInt(searchParams.get('windowDays') ?? '30', 10) || 30;
  const summary = await summarizeSpend(session.ws, { windowDays });
  return NextResponse.json({ summary });
});

import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getMonthlyBriefSpend } from '@/lib/niche-finder/brief-db';

/**
 * GET /api/niche-finder/favorites/brief-stats
 *   → { monthlySpendUsd: number }
 *
 * Sum of cost_usd across all 'ready' briefs in the current calendar
 * month for the workspace. Drives the Favorites tab header caption
 * ("Spent this month on briefs: $X.XX"). Lightweight — one SUM query.
 */
export const GET = apiRoute.authed(async (session) => {
  const monthlySpendUsd = await getMonthlyBriefSpend(session.ws);
  return NextResponse.json({ monthlySpendUsd });
});

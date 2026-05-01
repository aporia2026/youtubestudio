import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { resolveActiveChannelId } from '@/lib/active-channel';
import { buildDashboardSummary } from '@/lib/dashboard-summary';

/**
 * GET /api/dashboard/summary
 *
 * Returns the dashboard's four sections in one round trip:
 *   - today_publishes
 *   - stuck (items past their stage threshold)
 *   - underperformers (last 14 days, low CTR / AVP)
 *   - cadence (target vs actual uploads/week per channel)
 *
 * When the user has pinned an active channel, every section is filtered to
 * it. Otherwise the summary spans all channels in the workspace.
 */
export const GET = apiRoute.authed(async (session) => {
  const activeChannelId = await resolveActiveChannelId(session.uid, session.ws);
  const summary = await buildDashboardSummary({
    workspaceId: session.ws,
    activeChannelId,
  });
  return NextResponse.json(summary);
});

import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { resolveActiveChannelId } from '@/lib/active-channel';
import { getTrafficSourceSummary } from '@/lib/traffic-source-summary';

/**
 * GET /api/dashboard/traffic-sources
 *
 * Phase 9.2 — feeds the dashboard's TrafficSourceCard. Uses the
 * workspace's active channel pin (if set) to scope the window so the
 * card aligns with the rest of the dashboard's per-channel slice.
 */
export const GET = apiRoute.authed(async (session) => {
  const activeChannelId = await resolveActiveChannelId(session.uid, session.ws);
  const summary = await getTrafficSourceSummary({
    workspaceId: session.ws,
    channelDbId: activeChannelId,
    recentWindowDays: 30,
  });
  return NextResponse.json(summary);
});

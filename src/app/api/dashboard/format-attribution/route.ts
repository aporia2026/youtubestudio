import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { resolveActiveChannelId } from '@/lib/active-channel';
import { getFormatAttribution } from '@/lib/format-tags';

/**
 * GET /api/dashboard/format-attribution
 *
 * Phase 9.4 — feeds the FormatAttributionCard. Channel-scoped via
 * the workspace's active-channel pin.
 */
export const GET = apiRoute.authed(async (session) => {
  const activeChannelId = await resolveActiveChannelId(session.uid, session.ws);
  const stats = await getFormatAttribution({
    workspaceId: session.ws,
    channelDbId: activeChannelId,
  });
  return NextResponse.json({ stats });
});

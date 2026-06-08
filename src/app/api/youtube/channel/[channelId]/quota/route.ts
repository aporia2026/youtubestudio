import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { getQuotaUsage } from '@/lib/youtube-quota';

/**
 * GET /api/youtube/channel/[channelId]/quota
 *
 * Returns today's tracked quota usage for the channel — drives the
 * quota meter on the step-5 upload page. Conservative: this is the
 * app's view of what it has spent today, not Google's authoritative
 * view (other systems hitting the same Google Cloud project will
 * not show up here).
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ channelId: string }> }) => {
    const { channelId } = await ctx.params;

    const { rows } = await sql<{ id: string }>`
      SELECT id FROM channels
       WHERE id = ${channelId}::uuid AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Channel not found in this workspace' }, { status: 404 });
    }

    const snapshot = await getQuotaUsage({ channelId });
    return NextResponse.json(snapshot);
  },
);

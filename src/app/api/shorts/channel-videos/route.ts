import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getValidAccessToken } from '@/lib/google-oauth';
import { listMyVideosOAuth } from '@/lib/youtube';

/**
 * GET /api/shorts/channel-videos?channelDbId=...&limit=
 *
 * Lists the user's own connected channel's videos for Mode A's
 * channel-video picker. Reads via OAuth — same path the publishing
 * pipeline uses for videos.insert. Requires `oauth_connected = true`
 * on the channel row.
 *
 * Per the plan's source-scope decision: own channels only. Pasting an
 * arbitrary YouTube URL is NOT supported here; the picker is the only
 * entry point.
 *
 * Workspace scoping is enforced via the WHERE clause on `channels`.
 * A channelDbId that belongs to another workspace returns 404 (not 403
 * — no existence leak, matching the Phase 8.1 pattern).
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const channelDbId = searchParams.get('channelDbId');
  const limit = Math.min(50, Math.max(1, Number.parseInt(searchParams.get('limit') ?? '25', 10) || 25));

  if (!channelDbId) {
    return NextResponse.json({ error: 'channelDbId required' }, { status: 400 });
  }

  try {
    // Verify the channel belongs to this workspace + is OAuth-connected.
    const { rows } = await sql<{ oauth_connected: boolean }>`
      SELECT COALESCE(oauth_connected, false) AS oauth_connected
        FROM channels
       WHERE id = ${channelDbId}::uuid
         AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }
    if (!rows[0]!.oauth_connected) {
      return NextResponse.json(
        { error: 'Channel is not OAuth-connected. Connect it on the Channel page first.' },
        { status: 400 },
      );
    }

    const accessToken = await getValidAccessToken(channelDbId);
    if (!accessToken) {
      return NextResponse.json(
        { error: 'Could not get a valid access token. Reconnect the channel.' },
        { status: 502 },
      );
    }

    const videos = await listMyVideosOAuth(accessToken, limit);
    logger.info('[shorts mode-a list]', {
      workspaceId: session.ws,
      channelDbId,
      count: videos.length,
    });
    return NextResponse.json({ videos });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: list channel videos',
      fallbackMessage: 'Failed to list channel videos.',
    });
  }
});

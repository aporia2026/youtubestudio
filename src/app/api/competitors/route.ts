import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';
import { fetchChannelData } from '@/lib/youtube';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';

/**
 * Audit C2 + M11: previously this route had ZERO auth and ZERO
 * workspace filter — anyone could enumerate every workspace's
 * competitors. Now wrapped in apiRoute.authed and every query is
 * scoped by session.ws.
 */

export const GET = apiRoute.authed(async (session) => {
  await ensureCompetitorSchema();
  const result = await sql`
    SELECT c.*,
      (SELECT COUNT(*) FROM competitor_videos WHERE competitor_id = c.id) as video_count,
      (SELECT MAX(synced_at) FROM competitor_videos WHERE competitor_id = c.id) as last_synced
    FROM competitor_channels c
    WHERE c.workspace_id = ${session.ws}::uuid
    ORDER BY c.created_at DESC
  `;
  // Coerce BIGINT columns to JS numbers
  const competitors = result.rows.map((c) => ({
    ...c,
    subscriber_count: Number(c.subscriber_count) || 0,
    video_count: Number(c.video_count) || 0,
    view_count: Number(c.view_count) || 0,
  }));
  return NextResponse.json({ competitors });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  await ensureCompetitorSchema();
  const { channel_url } = await req.json();
  if (!channel_url) return NextResponse.json({ error: 'channel_url required' }, { status: 400 });

  try {
    const channelData = await fetchChannelData(channel_url);
    if (!channelData) {
      return NextResponse.json(
        { error: 'Could not fetch channel data. Check the URL or handle.' },
        { status: 400 },
      );
    }

    // Workspace-scoped duplicate check — two workspaces can each
    // track the same competitor (the constraint is now
    // UNIQUE(workspace_id, channel_id), see migration 0038).
    const existing = await sql`
      SELECT id FROM competitor_channels
       WHERE channel_id = ${channelData.id}
         AND workspace_id = ${session.ws}::uuid
    `;
    if (existing.rows.length > 0) {
      return NextResponse.json({ error: 'This channel is already being tracked' }, { status: 409 });
    }

    const result = await sql`
      INSERT INTO competitor_channels (
        workspace_id,
        channel_id, title, custom_url, description,
        subscriber_count, video_count, view_count, thumbnail_url
      )
      VALUES (
        ${session.ws}::uuid,
        ${channelData.id},
        ${channelData.title},
        ${channelData.customUrl || ''},
        ${channelData.description?.slice(0, 500) || ''},
        ${channelData.subscriberCount},
        ${channelData.videoCount},
        ${channelData.viewCount},
        ${channelData.thumbnailUrl || ''}
      )
      RETURNING *
    `;

    const c = result.rows[0];
    return NextResponse.json({
      competitor: {
        ...c,
        subscriber_count: Number(c.subscriber_count) || 0,
        video_count: Number(c.video_count) || 0,
        view_count: Number(c.view_count) || 0,
      },
    });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'competitors: create',
      knownPatterns: [
        { match: /channel_id.*unique|already being tracked/i, status: 409 },
      ],
      fallbackMessage: 'Failed to add competitor.',
    });
  }
});

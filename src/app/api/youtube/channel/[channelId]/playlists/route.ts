import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { getValidAccessToken } from '@/lib/google-oauth';
import { listMyPlaylists } from '@/lib/youtube-playlists';

/**
 * GET /api/youtube/channel/[channelId]/playlists
 *
 * Returns the channel's playlists for the batch-setup form's playlist
 * picker. The OAuth scope on the stored token determines which
 * playlists are visible (typically all owned by the authenticated
 * account).
 *
 * Workspace-scoped: the route refuses to issue tokens for a channel
 * outside the caller's workspace.
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

    const accessToken = await getValidAccessToken(channelId);
    if (!accessToken) {
      return NextResponse.json(
        { error: 'Channel is not OAuth-connected. Connect the channel first.' },
        { status: 409 },
      );
    }

    try {
      const playlists = await listMyPlaylists(accessToken);
      return NextResponse.json({ playlists });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  },
);

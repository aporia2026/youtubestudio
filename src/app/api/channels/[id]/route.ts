import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchChannelVideos, listMyVideosOAuth } from '@/lib/youtube';
import { getValidAccessToken, revokeOAuth } from '@/lib/google-oauth';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';

export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const ch = await sql`
        SELECT * FROM channels
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (!ch.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const channel = ch.rows[0]!;
      let videos: Array<{ video_id: string; title: string; thumbnail_url: string }> = [];

      // Try OAuth first
      const accessToken = await getValidAccessToken(id);
      if (accessToken) {
        try {
          const fetched = await listMyVideosOAuth(accessToken, 30);
          videos = fetched.map(v => ({ video_id: v.id, title: v.title, thumbnail_url: v.thumbnailUrl }));
        } catch { /* fall through to API key */ }
      }

      // Fall back to API key if no OAuth videos
      if (!videos.length && channel.channel_id) {
        const creds = typeof channel.api_credentials === 'string' ? JSON.parse(channel.api_credentials) : channel.api_credentials;
        const apiKey = creds?.youtube_api_key;
        try {
          const fetched = await fetchChannelVideos(channel.channel_id as string, 30, apiKey || undefined);
          videos = fetched.map(v => ({ video_id: v.id, title: v.title, thumbnail_url: v.thumbnailUrl }));
        } catch {
          // Videos fetch failed — return channel without videos
        }
      }

      // Strip sensitive fields before sending to client
      const { api_credentials: _, ...safeChannel } = channel as Record<string, unknown>;
      return NextResponse.json({ channel: safeChannel, videos });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'channels: get',
        fallbackMessage: 'Could not load channel — please try again.',
      });
    }
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      // Verify the channel belongs to the workspace before destructive action.
      const own = await sql`
        SELECT 1 FROM channels
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (own.rows.length === 0) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      // Revoke OAuth tokens with Google before deleting (best-effort).
      try { await revokeOAuth(id); } catch { /* best effort */ }
      await sql`
        DELETE FROM channels
         WHERE id = ${id} AND workspace_id = ${session.ws}::uuid
      `;
      return NextResponse.json({ success: true });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'channels: delete',
        fallbackMessage: 'Could not delete channel — please try again.',
      });
    }
  },
);

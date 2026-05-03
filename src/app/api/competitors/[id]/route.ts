import { NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';

/**
 * Audit C2: per-id reads/deletes were also unauthenticated and lacked
 * workspace scoping. Now wrapped + scoped — a request for an id that
 * belongs to a different workspace returns 404 (not 403, to avoid
 * leaking the existence of the row).
 */

export const GET = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await ensureCompetitorSchema();
    const channel = await sql`
      SELECT * FROM competitor_channels
       WHERE id = ${id}
         AND workspace_id = ${session.ws}::uuid
    `;
    if (channel.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const videos = await sql`
      SELECT * FROM competitor_videos
       WHERE competitor_id = ${id}
       ORDER BY published_at DESC
       LIMIT 200
    `;

    // Coerce NUMERIC/BIGINT columns to JS numbers — @vercel/postgres returns them as strings
    const normalizedVideos = videos.rows.map((v) => ({
      ...v,
      view_count: Number(v.view_count) || 0,
      like_count: Number(v.like_count) || 0,
      comment_count: Number(v.comment_count) || 0,
      duration_seconds: Number(v.duration_seconds) || 0,
      outlier_score: Number(v.outlier_score) || 0,
      engagement_rate: Number(v.engagement_rate) || 0,
    }));
    const ch = channel.rows[0];
    const normalizedChannel = {
      ...ch,
      subscriber_count: Number(ch.subscriber_count) || 0,
      video_count: Number(ch.video_count) || 0,
      view_count: Number(ch.view_count) || 0,
    };

    return NextResponse.json({ competitor: normalizedChannel, videos: normalizedVideos });
  },
);

export const DELETE = apiRoute.authed(
  async (session, _req, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // Workspace-scoped DELETE — both queries are bounded by the
    // session's workspace, so a stolen id from another tenant has no
    // effect.
    await sql`
      DELETE FROM competitor_videos
       WHERE competitor_id IN (
         SELECT id FROM competitor_channels
          WHERE id = ${id}
            AND workspace_id = ${session.ws}::uuid
       )
    `;
    const result = await sql`
      DELETE FROM competitor_channels
       WHERE id = ${id}
         AND workspace_id = ${session.ws}::uuid
    `;
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  },
);

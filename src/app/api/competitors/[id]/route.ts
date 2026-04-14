import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureCompetitorSchema } from '@/lib/db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureCompetitorSchema();
    const channel = await sql`SELECT * FROM competitor_channels WHERE id = ${id}`;
    if (channel.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const videos = await sql`
      SELECT * FROM competitor_videos
      WHERE competitor_id = ${id}
      ORDER BY published_at DESC
      LIMIT 200
    `;

    // Coerce NUMERIC/BIGINT columns to JS numbers — @vercel/postgres returns them as strings
    const normalizedVideos = videos.rows.map(v => ({
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
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await sql`DELETE FROM competitor_videos WHERE competitor_id = ${id}`;
    await sql`DELETE FROM competitor_channels WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchYouTubeVideoData } from '@/lib/youtube';
import { logger } from '@/lib/logger';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await sql`
      SELECT * FROM youtube_references WHERE project_id = ${id} ORDER BY created_at DESC
    `;
    return NextResponse.json({ references: result.rows });
  } catch {
    return NextResponse.json({ references: [] });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { youtube_url, notes } = await req.json();

  if (!youtube_url) return NextResponse.json({ error: 'youtube_url required' }, { status: 400 });

  try {
    // Try to fetch YouTube metadata
    const videoData = await fetchYouTubeVideoData(youtube_url);

    // workspace_id is NOT NULL on youtube_references since migration 0013 —
    // copy it from the parent project so this insert satisfies the constraint.
    const scrapedAt = videoData ? new Date().toISOString() : null;
    const result = await sql`
      INSERT INTO youtube_references (
        project_id, youtube_url, video_id, title, channel,
        view_count, like_count, duration, thumbnail_url, notes, scraped_at, workspace_id
      )
      SELECT ${id}::uuid, ${youtube_url}, ${videoData?.id || null},
             ${videoData?.title || null}, ${videoData?.channelTitle || null},
             ${videoData?.viewCount || 0}, ${videoData?.likeCount || 0},
             ${videoData?.duration || null}, ${videoData?.thumbnailUrl || null},
             ${notes || ''}, ${scrapedAt}::timestamptz, p.workspace_id
        FROM projects p WHERE p.id = ${id}::uuid
      RETURNING *
    `;
    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json({ reference: result.rows[0] });
  } catch (err) {
    logger.error('error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

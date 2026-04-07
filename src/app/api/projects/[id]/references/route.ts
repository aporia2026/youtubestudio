import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchYouTubeVideoData } from '@/lib/youtube';

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

    const scrapedAt = videoData ? new Date().toISOString() : null;
    const result = await sql`
      INSERT INTO youtube_references (
        project_id, youtube_url, video_id, title, channel,
        view_count, like_count, duration, thumbnail_url, notes, scraped_at
      )
      VALUES (
        ${id},
        ${youtube_url},
        ${videoData?.id || null},
        ${videoData?.title || null},
        ${videoData?.channelTitle || null},
        ${videoData?.viewCount || 0},
        ${videoData?.likeCount || 0},
        ${videoData?.duration || null},
        ${videoData?.thumbnailUrl || null},
        ${notes || ''},
        ${scrapedAt}
      )
      RETURNING *
    `;

    return NextResponse.json({ reference: result.rows[0] });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchChannelData } from '@/lib/youtube';

export async function GET() {
  try {
    const result = await sql`SELECT * FROM channels ORDER BY created_at DESC`;
    return NextResponse.json({ channels: result.rows });
  } catch {
    return NextResponse.json({ channels: [] });
  }
}

export async function POST(req: NextRequest) {
  const { url, niche } = await req.json();
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 });

  try {
    // Try to fetch channel data from YouTube API
    const channelData = await fetchChannelData(url);

    const name = channelData?.title || url;
    const result = await sql`
      INSERT INTO channels (channel_id, name, handle, description, subscriber_count, video_count, niche, thumbnail_url)
      VALUES (
        ${channelData?.id || null},
        ${name},
        ${channelData?.customUrl || null},
        ${channelData?.description || null},
        ${channelData?.subscriberCount || 0},
        ${channelData?.videoCount || 0},
        ${niche || null},
        ${channelData?.thumbnailUrl || null}
      )
      ON CONFLICT (channel_id) DO UPDATE SET
        name = EXCLUDED.name,
        subscriber_count = EXCLUDED.subscriber_count,
        video_count = EXCLUDED.video_count,
        thumbnail_url = EXCLUDED.thumbnail_url
      RETURNING *
    `;

    return NextResponse.json({ channel: result.rows[0] });
  } catch (err: unknown) {
    console.error(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}

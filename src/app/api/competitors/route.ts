import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchChannelData } from '@/lib/youtube';

export async function GET() {
  try {
    const result = await sql`
      SELECT c.*,
        (SELECT COUNT(*) FROM competitor_videos WHERE competitor_id = c.id) as video_count,
        (SELECT MAX(synced_at) FROM competitor_videos WHERE competitor_id = c.id) as last_synced
      FROM competitor_channels c
      ORDER BY c.created_at DESC
    `;
    return NextResponse.json({ competitors: result.rows });
  } catch {
    return NextResponse.json({ competitors: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { channel_url } = await req.json();
    if (!channel_url) return NextResponse.json({ error: 'channel_url required' }, { status: 400 });

    // Fetch channel data from YouTube
    const channelData = await fetchChannelData(channel_url);
    if (!channelData) {
      return NextResponse.json({ error: 'Could not fetch channel data. Check the URL or handle.' }, { status: 400 });
    }

    // Check for duplicate
    const existing = await sql`SELECT id FROM competitor_channels WHERE channel_id = ${channelData.id}`;
    if (existing.rows.length > 0) {
      return NextResponse.json({ error: 'This channel is already being tracked' }, { status: 409 });
    }

    const result = await sql`
      INSERT INTO competitor_channels (
        channel_id, title, custom_url, description,
        subscriber_count, video_count, view_count, thumbnail_url
      )
      VALUES (
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

    return NextResponse.json({ competitor: result.rows[0] });
  } catch (err) {
    console.error('Add competitor error:', err);
    return NextResponse.json({ error: 'Failed to add competitor' }, { status: 500 });
  }
}

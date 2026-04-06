import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchChannelData } from '@/lib/youtube';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ch = await sql`SELECT * FROM channels WHERE id = ${id}`;
    if (!ch.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const channel = ch.rows[0];
    if (!channel.channel_id) return NextResponse.json({ error: 'No YouTube channel ID — add YouTube API key first' }, { status: 400 });

    // Use per-channel API key if available, otherwise fall back to global
    const channelApiKey = channel.api_credentials?.youtube_api_key;
    const data = await fetchChannelData(channel.channel_id, channelApiKey || undefined);
    if (!data) return NextResponse.json({ error: 'Failed to fetch channel data' }, { status: 500 });

    await sql`
      UPDATE channels SET
        name = ${data.title},
        description = ${data.description},
        subscriber_count = ${data.subscriberCount},
        video_count = ${data.videoCount},
        thumbnail_url = ${data.thumbnailUrl},
        last_synced_at = NOW()
      WHERE id = ${id}
    `;

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Sync failed' }, { status: 500 });
  }
}

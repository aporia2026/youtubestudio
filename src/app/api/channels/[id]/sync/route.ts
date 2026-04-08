import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchChannelData, fetchMyChannelOAuth } from '@/lib/youtube';
import { getValidAccessToken } from '@/lib/google-oauth';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ch = await sql`SELECT * FROM channels WHERE id = ${id}`;
    if (!ch.rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const channel = ch.rows[0];

    // Try OAuth first
    const accessToken = await getValidAccessToken(id);
    if (accessToken) {
      const data = await fetchMyChannelOAuth(accessToken);
      if (data) {
        await sql`
          UPDATE channels SET
            channel_id = ${data.id},
            name = ${data.title},
            description = ${data.description},
            subscriber_count = ${data.subscriberCount},
            video_count = ${data.videoCount},
            thumbnail_url = ${data.thumbnailUrl},
            handle = ${data.customUrl || null},
            last_synced_at = NOW()
          WHERE id = ${id}
        `;
        return NextResponse.json({ success: true, method: 'oauth' });
      }
    }

    // Fall back to API key
    if (!channel.channel_id) return NextResponse.json({ error: 'No YouTube channel ID — connect via OAuth or add an API key' }, { status: 400 });

    const creds = typeof channel.api_credentials === 'string' ? JSON.parse(channel.api_credentials) : channel.api_credentials;
    const channelApiKey = creds?.youtube_api_key;
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

    return NextResponse.json({ success: true, method: 'api_key' });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Sync failed' }, { status: 500 });
  }
}

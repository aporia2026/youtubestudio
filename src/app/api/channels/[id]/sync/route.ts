import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchChannelData, fetchMyChannelOAuth } from '@/lib/youtube';
import { getValidAccessToken } from '@/lib/google-oauth';
import { logger } from '@/lib/logger';

/** Cover cold starts + occasionally slow YouTube API responses. Matches the
 *  pattern used by /api/channels/[id]/analyze (300s) and the visual-brand-kit
 *  logo route (30s) — sync is a single API call + a DB write so 60s is
 *  generous without being wasteful. */
export const maxDuration = 60;

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
  } catch (err) {
    // Surface the real error to the client. Sync operates on the caller's
    // own channel + their own workspace, so the underlying YouTube /
    // database / OAuth message is not sensitive — and the generic
    // "try again" message has been masking actionable failures (expired
    // refresh token, quota exceeded, schema drift) for too long. Server
    // logs still get the structured detail.
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('channels: sync: unexpected failure', { detail });
    return NextResponse.json(
      { error: `Sync failed: ${detail}` },
      { status: 500 },
    );
  }
}

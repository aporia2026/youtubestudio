import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { fetchChannelData } from '@/lib/youtube';

export async function GET() {
  try {
    const result = await sql`
      SELECT id, channel_id, name, handle, description, subscriber_count, video_count,
             niche, thumbnail_url, last_synced_at, account_label, account_email, account_color, notes,
             CASE WHEN api_credentials IS NOT NULL AND api_credentials != '{}' THEN true ELSE false END as has_api_key,
             created_at
      FROM channels ORDER BY created_at DESC
    `;
    return NextResponse.json({ channels: result.rows });
  } catch {
    return NextResponse.json({ channels: [] });
  }
}

export async function POST(req: NextRequest) {
  const { url, niche, accountLabel, accountEmail, accountColor, accountApiKey, notes } = await req.json();
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 });

  try {
    // Try to fetch channel data from YouTube API (use per-account key if provided)
    const channelData = await fetchChannelData(url, accountApiKey || undefined);

    // Prevent duplicates when no channel_id is available
    if (!channelData?.id) {
      const existing = await sql`SELECT id FROM channels WHERE name = ${url} LIMIT 1`;
      if (existing.rows.length > 0) {
        return NextResponse.json({ error: 'This channel was already added. Configure a YouTube API key to fetch proper channel data.' }, { status: 409 });
      }
    }

    const name = channelData?.title || url;
    const credentials = accountApiKey ? JSON.stringify({ youtube_api_key: accountApiKey }) : '{}';
    const result = await sql`
      INSERT INTO channels (channel_id, name, handle, description, subscriber_count, video_count, niche, thumbnail_url, account_label, account_email, account_color, notes, api_credentials)
      VALUES (
        ${channelData?.id || null},
        ${name},
        ${channelData?.customUrl || null},
        ${channelData?.description || null},
        ${channelData?.subscriberCount || 0},
        ${channelData?.videoCount || 0},
        ${niche || null},
        ${channelData?.thumbnailUrl || null},
        ${accountLabel || null},
        ${accountEmail || null},
        ${accountColor || '#7c3aed'},
        ${notes || null},
        ${credentials}
      )
      ON CONFLICT (channel_id) DO UPDATE SET
        name = EXCLUDED.name,
        subscriber_count = EXCLUDED.subscriber_count,
        video_count = EXCLUDED.video_count,
        thumbnail_url = EXCLUDED.thumbnail_url,
        account_label = COALESCE(EXCLUDED.account_label, channels.account_label),
        account_email = COALESCE(EXCLUDED.account_email, channels.account_email),
        account_color = COALESCE(EXCLUDED.account_color, channels.account_color),
        notes = COALESCE(EXCLUDED.notes, channels.notes),
        api_credentials = CASE WHEN EXCLUDED.api_credentials != '{}' THEN EXCLUDED.api_credentials ELSE channels.api_credentials END
      RETURNING *
    `;

    return NextResponse.json({ channel: result.rows[0] });
  } catch (err: unknown) {
    console.error(err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { sql, ensureChannelsSchema } from '@/lib/db';
import { fetchChannelData } from '@/lib/youtube';
import { apiRoute } from '@/lib/route-helpers';

export const GET = apiRoute.authed(async (session) => {
  try {
    await ensureChannelsSchema();
    const result = await sql`
      SELECT id, channel_id, name, handle, description, subscriber_count, video_count,
             niche, thumbnail_url, last_synced_at, account_label, account_email, account_color, notes,
             CASE WHEN api_credentials IS NOT NULL AND api_credentials != '{}' THEN true ELSE false END as has_api_key,
             COALESCE(oauth_connected, false) as oauth_connected,
             created_at
      FROM channels
      WHERE workspace_id = ${session.ws}::uuid
      ORDER BY created_at DESC
    `;
    return NextResponse.json({ channels: result.rows });
  } catch {
    return NextResponse.json({ channels: [] });
  }
});

export const POST = apiRoute.authed(async (session, req) => {
  const { url, niche, accountLabel, accountEmail, accountColor, accountApiKey, notes } = await req.json();
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 });

  try {
    await ensureChannelsSchema();
    const channelData = await fetchChannelData(url, accountApiKey || undefined);

    // Duplicate check is now per-workspace — different workspaces can each
    // add the same external channel without colliding.
    if (!channelData?.id) {
      const existing = await sql`
        SELECT id FROM channels
         WHERE name = ${url} AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (existing.rows.length > 0) {
        return NextResponse.json(
          { error: 'This channel was already added. Configure a YouTube API key to fetch proper channel data.' },
          { status: 409 },
        );
      }
    }

    const name = channelData?.title || url;
    const credentials = accountApiKey ? JSON.stringify({ youtube_api_key: accountApiKey }) : '{}';

    // The (channel_id) UNIQUE index from the legacy schema is GLOBAL — two
    // workspaces can't add the same external channel even though they
    // conceptually should be able to. PR #5 leaves that as-is; revisit when
    // we onboard a second tenant who hits the conflict.
    const result = await sql`
      INSERT INTO channels (channel_id, name, handle, description, subscriber_count, video_count, niche, thumbnail_url, account_label, account_email, account_color, notes, api_credentials, workspace_id)
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
        ${credentials},
        ${session.ws}::uuid
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
});

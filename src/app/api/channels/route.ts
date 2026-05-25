import { NextResponse } from 'next/server';
import { sql, ensureChannelsSchema } from '@/lib/db';
import { fetchChannelData } from '@/lib/youtube';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

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

/** Cap on user-supplied description / brief at INSERT time. Matches the
 *  caps applied by PATCH so the entry-on-create path can't bypass them. */
const MAX_DESCRIPTION_CHARS = 5000;
const MAX_BRIEF_CHARS = 4000;

function clampText(raw: unknown, cap: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.slice(0, cap).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const POST = apiRoute.authed(async (session, req) => {
  const {
    url,
    niche,
    accountLabel,
    accountEmail,
    accountColor,
    accountApiKey,
    notes,
    description: descriptionInput,
    descriptionBrief: descriptionBriefInput,
  } = await req.json();
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

    // User-supplied description (e.g. from the AI generator) overrides the
    // YouTube About fetched in channelData. The brief is kept alongside it
    // so the description page can prefill the next iteration.
    const userDescription = clampText(descriptionInput, MAX_DESCRIPTION_CHARS);
    const description = userDescription ?? channelData?.description ?? null;
    const descriptionBrief = clampText(descriptionBriefInput, MAX_BRIEF_CHARS);

    // ON CONFLICT target matches migration 0019's compound UNIQUE
    // (workspace_id, channel_id). Different workspaces can each add the same
    // external channel; only collisions WITHIN a workspace trigger the
    // upsert path, so we never leak data across the tenant boundary.
    const result = await sql`
      INSERT INTO channels (channel_id, name, handle, description, description_brief, subscriber_count, video_count, niche, thumbnail_url, account_label, account_email, account_color, notes, api_credentials, workspace_id)
      VALUES (
        ${channelData?.id || null},
        ${name},
        ${channelData?.customUrl || null},
        ${description},
        ${descriptionBrief},
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
      ON CONFLICT (workspace_id, channel_id) DO UPDATE SET
        name = EXCLUDED.name,
        subscriber_count = EXCLUDED.subscriber_count,
        video_count = EXCLUDED.video_count,
        thumbnail_url = EXCLUDED.thumbnail_url,
        account_label = COALESCE(EXCLUDED.account_label, channels.account_label),
        account_email = COALESCE(EXCLUDED.account_email, channels.account_email),
        account_color = COALESCE(EXCLUDED.account_color, channels.account_color),
        notes = COALESCE(EXCLUDED.notes, channels.notes),
        api_credentials = CASE WHEN EXCLUDED.api_credentials != '{}' THEN EXCLUDED.api_credentials ELSE channels.api_credentials END
        -- description and description_brief deliberately omitted here: a
        -- re-add of an existing channel must not stomp the description the
        -- user has tuned on /channel/[id]/description. Use PATCH for edits.
      RETURNING *
    `;

    return NextResponse.json({ channel: result.rows[0] });
  } catch (err: unknown) {
    logger.error('error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
});

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { extractVideoId } from '@/lib/youtube';
import {
  syncVideoAnalytics,
  readVideoAnalyticsRow,
} from '@/lib/youtube-analytics';

interface ScheduleItemForAnalytics {
  id: string;
  workspace_id: string;
  youtube_url: string | null;
  channel_db_id: string | null;
  youtube_channel_id: string | null;
}

/** Resolve a schedule item + its associated channel, scoped to the user's
 *  workspace. Returns null if the item doesn't exist or doesn't belong to
 *  this workspace. */
async function resolveScheduleItem(
  itemId: string,
  workspaceId: string,
): Promise<ScheduleItemForAnalytics | null> {
  const { rows } = await sql<ScheduleItemForAnalytics>`
    SELECT
      si.id,
      si.workspace_id,
      si.youtube_url,
      c.id AS channel_db_id,
      c.channel_id AS youtube_channel_id
    FROM schedule_items si
    LEFT JOIN schedule_item_channels sic ON sic.item_id = si.id
    LEFT JOIN channels c ON c.id = sic.channel_id
    WHERE si.id = ${itemId}::uuid
      AND si.workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * GET /api/schedule/[id]/analytics
 *
 * Returns the cached analytics row for this schedule item, if any.
 * Returns 404 with a structured "not_synced" hint when no row exists yet,
 * so the client knows to call POST to populate.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const item = await resolveScheduleItem(id, session.ws);
    if (!item) {
      return NextResponse.json({ error: 'Schedule item not found' }, { status: 404 });
    }
    if (!item.youtube_url) {
      return NextResponse.json(
        { error: 'Schedule item has no YouTube URL — nothing to fetch.', status: 'no_url' },
        { status: 400 },
      );
    }
    const videoId = extractVideoId(item.youtube_url);
    if (!videoId) {
      return NextResponse.json(
        { error: 'Could not extract a video id from the YouTube URL.', status: 'bad_url' },
        { status: 400 },
      );
    }
    try {
      const row = await readVideoAnalyticsRow(session.ws, videoId);
      return NextResponse.json({ analytics: row });
    } catch {
      return NextResponse.json(
        { error: 'No analytics cached yet — POST to /sync to populate.', status: 'not_synced' },
        { status: 404 },
      );
    }
  },
);

/**
 * POST /api/schedule/[id]/analytics  (sync)
 *
 * Pulls fresh stats from the YouTube Data API and (best-effort) the
 * Analytics API, upserts into video_analytics, returns the persisted row.
 *
 * Errors:
 *   - 400 if the schedule item has no YouTube URL or the URL doesn't yield
 *     a video id.
 *   - 409 if the schedule item isn't linked to a channel (we need the
 *     channel's OAuth token to query the YouTube APIs).
 *   - 502 if the YouTube API call fails (proxy back the message).
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const item = await resolveScheduleItem(id, session.ws);
    if (!item) {
      return NextResponse.json({ error: 'Schedule item not found' }, { status: 404 });
    }
    if (!item.youtube_url) {
      return NextResponse.json({ error: 'Schedule item has no YouTube URL.' }, { status: 400 });
    }
    const videoId = extractVideoId(item.youtube_url);
    if (!videoId) {
      return NextResponse.json(
        { error: 'Could not extract a video id from the YouTube URL.' },
        { status: 400 },
      );
    }
    if (!item.channel_db_id) {
      return NextResponse.json(
        {
          error:
            'Schedule item is not linked to a channel. Assign a channel and connect it via OAuth before syncing analytics.',
        },
        { status: 409 },
      );
    }

    try {
      const row = await syncVideoAnalytics({
        workspaceId: session.ws,
        channelDbId: item.channel_db_id,
        scheduleItemId: item.id,
        youtubeChannelId: item.youtube_channel_id,
        youtubeVideoId: videoId,
      });
      return NextResponse.json({ analytics: row, status: 'synced' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // OAuth-not-connected is a 409 (user needs to take action).
      if (msg.toLowerCase().includes('oauth-connected')) {
        return NextResponse.json({ error: msg }, { status: 409 });
      }
      return NextResponse.json({ error: `YouTube sync failed: ${msg}` }, { status: 502 });
    }
  },
);

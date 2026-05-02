import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import { syncCommentsForVideo } from '@/lib/youtube-comments';

export const maxDuration = 60;

/**
 * POST /api/comments/sync
 *
 * Body: { youtubeVideoId: string, channelDbId?: string, maxPages?: number }
 *
 * Pulls comment threads for the video from YouTube via YOUTUBE_API_KEY
 * (read-only, no OAuth needed) and upserts into youtube_comments. Records
 * a comment_sync_runs row with totals.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const youtubeVideoId = typeof b.youtubeVideoId === 'string' ? b.youtubeVideoId.trim() : '';
  if (!youtubeVideoId) {
    return NextResponse.json({ error: 'youtubeVideoId is required' }, { status: 400 });
  }
  const channelDbId = typeof b.channelDbId === 'string' && b.channelDbId ? b.channelDbId : null;
  const maxPages =
    typeof b.maxPages === 'number' && Number.isFinite(b.maxPages)
      ? Math.max(1, Math.min(20, Math.round(b.maxPages)))
      : undefined;

  try {
    if (channelDbId) await assertOwnsResource('channels', channelDbId, session.ws);
  } catch (err) {
    if (err instanceof ResourceNotInWorkspaceError) {
      return NextResponse.json({ error: 'Channel not found in this workspace' }, { status: 404 });
    }
    throw err;
  }

  try {
    const result = await syncCommentsForVideo({
      workspaceId: session.ws,
      channelDbId,
      youtubeVideoId,
      maxPages,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
});

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { commentIntentCounts, listComments } from '@/lib/youtube-comments';
import { isCommentIntent } from '@/lib/youtube-comments-types';

/**
 * GET /api/comments?videoId=&channelDbId=&intent=&unrepliedOnly=&limit=
 *
 * Lists top-level comments in the workspace, newest first. Also returns
 * an aggregate count per intent so the UI can render filter pills with
 * counts in one round-trip.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const videoId = searchParams.get('videoId') || undefined;
  const channelDbId = searchParams.get('channelDbId') || undefined;
  const intentRaw = searchParams.get('intent');
  const intent = intentRaw && isCommentIntent(intentRaw) ? intentRaw : undefined;
  const unrepliedOnly = searchParams.get('unrepliedOnly') === '1';
  const limit = Number.parseInt(searchParams.get('limit') ?? '100', 10) || 100;

  const [comments, counts] = await Promise.all([
    listComments(session.ws, { videoId, channelDbId, intent, unrepliedOnly, limit }),
    commentIntentCounts(session.ws, { videoId, channelDbId }),
  ]);
  return NextResponse.json({ comments, counts });
});

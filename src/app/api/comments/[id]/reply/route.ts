import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { replyToComment } from '@/lib/youtube-comments';

export const maxDuration = 30;

/**
 * POST /api/comments/[id]/reply
 *
 * Body: { replyText: string }
 *
 * Posts a reply via the channel's OAuth token. The full text is cached
 * onto our row so the UI can show it without a YouTube round-trip.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const replyText = typeof (body as { replyText?: unknown })?.replyText === 'string'
      ? (body as { replyText: string }).replyText
      : '';
    if (!replyText.trim()) {
      return NextResponse.json({ error: 'replyText is required' }, { status: 400 });
    }
    try {
      const result = await replyToComment({ id, workspaceId: session.ws, replyText });
      return NextResponse.json(result);
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'comments: reply',
        knownPatterns: [
          { match: /not found/i, status: 404 },
          { match: /not OAuth|associated channel|exceeds/i, status: 409 },
        ],
        fallbackMessage: 'Could not post the reply.',
      });
    }
  },
);

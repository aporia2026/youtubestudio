import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { setCommentModeration } from '@/lib/youtube-comments';

export const maxDuration = 30;

/**
 * POST /api/comments/[id]/moderate
 *
 * Body: { status: 'heldForReview' | 'published' | 'rejected', banAuthor?: boolean }
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
    const b = (body ?? {}) as Record<string, unknown>;
    const status = b.status;
    if (status !== 'heldForReview' && status !== 'published' && status !== 'rejected') {
      return NextResponse.json(
        { error: 'status must be heldForReview, published, or rejected' },
        { status: 400 },
      );
    }
    const banAuthor = b.banAuthor === true;
    try {
      await setCommentModeration({ id, workspaceId: session.ws, status, banAuthor });
      return NextResponse.json({ ok: true, status });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'comments: moderate',
        knownPatterns: [
          { match: /not found/i, status: 404 },
          { match: /not OAuth|associated channel/i, status: 409 },
        ],
        fallbackMessage: 'Could not update comment moderation.',
      });
    }
  },
);

import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { getAskStudioThread } from '@/lib/ask-studio';

/**
 * GET /api/ask-studio/questions/:id/thread
 *
 * Returns every turn in the thread rooted at `:id` (the root question id)
 * oldest first. Used by the UI when a card is expanded so the user sees
 * the full conversation, and after a reply succeeds so the new turn
 * appears without a full history refetch.
 *
 * `:id` is expected to be a thread ROOT (parent_id IS NULL). Passing a
 * non-root id returns only that subtree, which is technically valid but
 * probably not what the caller wanted.
 */
export const GET = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const turns = await getAskStudioThread(id, session.ws);
    if (turns.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ turns });
  },
);

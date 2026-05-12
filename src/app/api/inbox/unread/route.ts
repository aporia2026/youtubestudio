import { NextResponse } from 'next/server';
import { requireUser, SessionError } from '@/lib/session';
import { countUnresolvedInbox } from '@/lib/inbox-db';
import { logger } from '@/lib/logger';

/**
 * Cheap COUNT used by the sidebar badge. Polled every 30s and on window
 * focus by the `useCommentsUnread` hook — kept on its own route so the
 * full list payload doesn't ride along on every tick.
 */
export async function GET() {
  try {
    const session = await requireUser();
    const unread = await countUnresolvedInbox(session.ws);
    return NextResponse.json({ unread });
  } catch (err: unknown) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error('GET /api/inbox/unread error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to load inbox count' }, { status: 500 });
  }
}

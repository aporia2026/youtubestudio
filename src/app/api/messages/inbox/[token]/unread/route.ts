import { NextRequest, NextResponse } from 'next/server';
import { getCollaboratorByPersonalToken, getUnreadCountForUser } from '@/lib/messages-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * Light unread-count probe for the dashboard nav badge. Avoids loading
 * the full thread when all the dashboard needs is "do I have a number
 * to render". Polled every ~15s by the portal pages.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const me = await getCollaboratorByPersonalToken(token);
    if (!me) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });
    const n = await getUnreadCountForUser(me.id);
    return NextResponse.json({ unread: n });
  } catch (err) {
    logger.error('GET inbox unread error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

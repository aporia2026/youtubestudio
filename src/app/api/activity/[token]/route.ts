import { NextRequest, NextResponse } from 'next/server';
import { getCollaboratorByPersonalToken } from '@/lib/team-db';
import { listActivity, countUnreadActivity, markActivityRead } from '@/lib/activity-feed';
import { logger } from '@/lib/logger';

/**
 * GET — recent events for a collaborator's bell, plus unread count.
 *
 * Query params:
 *   - limit (default 30, max 100)
 *   - unread_only=1 to filter to unread only
 *
 * POST — { id?: string, all?: boolean } marks events as read.
 *   - { all: true } marks every unread event read
 *   - { id: '<uuid>' } marks a single event read
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const me = await getCollaboratorByPersonalToken(token);
    if (!me) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const sp = req.nextUrl.searchParams;
    const limit = Math.min(Math.max(parseInt(sp.get('limit') || '30', 10) || 30, 1), 100);
    const unreadOnly = sp.get('unread_only') === '1';

    const [events, unreadCount] = await Promise.all([
      listActivity(me.id as string, { limit, unreadOnly }),
      countUnreadActivity(me.id as string),
    ]);

    return NextResponse.json({ events, unreadCount });
  } catch (err) {
    logger.error('GET activity error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const me = await getCollaboratorByPersonalToken(token);
    if (!me) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    if (body.all) {
      await markActivityRead(me.id as string, { all: true });
    } else if (typeof body.id === 'string') {
      await markActivityRead(me.id as string, { id: body.id });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('POST activity error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

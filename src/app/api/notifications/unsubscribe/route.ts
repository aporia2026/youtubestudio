import { NextRequest, NextResponse } from 'next/server';
import { getCollaboratorByUnsubscribeToken, setCollaboratorNotifications } from '@/lib/notifications-db';
import { logger } from '@/lib/logger';

/** Public — flips notifications off for a collaborator. Used by email links. */
export async function POST(req: NextRequest) {
  try {
    const { token, enabled } = await req.json();
    if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });
    const collab = await getCollaboratorByUnsubscribeToken(token);
    if (!collab) return NextResponse.json({ error: 'Invalid token' }, { status: 404 });
    await setCollaboratorNotifications(collab.id, !!enabled);
    return NextResponse.json({ ok: true, name: collab.name, enabled: !!enabled });
  } catch (err) {
    logger.error('unsubscribe error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import {
  getCollaboratorByPersonalToken,
  getWorkspaceOwner,
  getThread,
  createMessage,
  markThreadRead,
  getUnreadCountForUser,
} from '@/lib/messages-db';
import { notifyMessage } from '@/lib/notify';

export const runtime = 'nodejs';

/**
 * GET — load the chat thread between this collaborator and the workspace
 * owner, then mark every owner-authored message as read so the unread
 * badge clears on view.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const me = await getCollaboratorByPersonalToken(token);
    if (!me) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });
    const owner = await getWorkspaceOwner();
    if (!owner) return NextResponse.json({ error: 'No workspace owner configured' }, { status: 503 });
    if (owner.id === me.id) return NextResponse.json({ error: 'Owner uses /messages, not the inbox token route' }, { status: 400 });

    const messages = await getThread(me.id, owner.id);
    // Mark owner→me messages read on view. The recipient sees the bubble
    // immediately and the badge clears without an explicit PATCH.
    await markThreadRead(me.id, owner.id);

    return NextResponse.json({
      me: { id: me.id, name: me.name, color: me.color, role: me.role },
      counterpart: { id: owner.id, name: owner.name, color: owner.color, role: 'owner' },
      messages,
    });
  } catch (err) {
    console.error('GET inbox thread error:', err);
    return NextResponse.json({ error: 'Failed to load thread' }, { status: 500 });
  }
}

/** POST — collaborator sends a message to the owner. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const me = await getCollaboratorByPersonalToken(token);
    if (!me) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });
    const owner = await getWorkspaceOwner();
    if (!owner) return NextResponse.json({ error: 'No workspace owner configured' }, { status: 503 });

    const body = await req.json();
    const text: string = (body?.text || '').trim();
    if (!text) return NextResponse.json({ error: 'text required' }, { status: 400 });

    const created = await createMessage({
      from_collaborator_id: me.id,
      to_collaborator_id: owner.id,
      text,
      workspace_id: owner.workspace_id,
    });

    // Fire-and-forget notify.
    notifyMessage({
      fromName: me.name,
      recipientRole: 'owner',
      text,
    }).catch(e => console.error('notifyMessage(owner) failed:', e));

    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error('POST inbox message error:', err);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}

/**
 * GET ?count=1 — quick unread-count for the dashboard nav badge.
 * Used by the narrator/editor portals so they can render a badge without
 * loading the whole thread.
 */
// (We piggyback on a separate route — see /api/messages/inbox/[token]/unread)

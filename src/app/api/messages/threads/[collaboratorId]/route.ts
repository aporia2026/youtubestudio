import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import {
  getWorkspaceOwner,
  getThread,
  markThreadRead,
  createMessage,
} from '@/lib/messages-db';
import { notifyMessage } from '@/lib/notify';

export const runtime = 'nodejs';

/**
 * Look up a collaborator by id, returning the slim shape the chat panel
 * wants (name, color, role) so the owner-side UI can render the header
 * without joining workspaces tables itself.
 */
async function getCollaboratorById(id: string) {
  try {
    const { rows } = await sql`
      SELECT id, name, email, color, role, personal_token
      FROM collaborators
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * Owner-side GET: load the thread between the owner and the named
 * collaborator. Marks every collaborator→owner message as read on view.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ collaboratorId: string }> }) {
  try {
    const { collaboratorId } = await params;
    const owner = await getWorkspaceOwner();
    if (!owner) return NextResponse.json({ error: 'No workspace owner configured' }, { status: 503 });
    if (collaboratorId === owner.id) {
      return NextResponse.json({ error: 'Cannot open a thread with yourself' }, { status: 400 });
    }
    const counterpart = await getCollaboratorById(collaboratorId);
    if (!counterpart) return NextResponse.json({ error: 'Collaborator not found' }, { status: 404 });

    const messages = await getThread(owner.id, counterpart.id as string);
    await markThreadRead(owner.id, counterpart.id as string);

    return NextResponse.json({
      me: { id: owner.id, name: owner.name, color: owner.color, role: 'owner' },
      counterpart: {
        id: counterpart.id,
        name: counterpart.name,
        color: counterpart.color,
        role: counterpart.role,
        personal_token: counterpart.personal_token,
      },
      messages,
    });
  } catch (err) {
    console.error('GET owner thread error:', err);
    return NextResponse.json({ error: 'Failed to load thread' }, { status: 500 });
  }
}

/** Owner-side POST: send a message to the named collaborator. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ collaboratorId: string }> }) {
  try {
    const { collaboratorId } = await params;
    const owner = await getWorkspaceOwner();
    if (!owner) return NextResponse.json({ error: 'No workspace owner configured' }, { status: 503 });
    if (collaboratorId === owner.id) {
      return NextResponse.json({ error: 'Cannot message yourself' }, { status: 400 });
    }
    const counterpart = await getCollaboratorById(collaboratorId);
    if (!counterpart) return NextResponse.json({ error: 'Collaborator not found' }, { status: 404 });

    const body = await req.json();
    const text: string = (body?.text || '').trim();
    if (!text) return NextResponse.json({ error: 'text required' }, { status: 400 });

    const created = await createMessage({
      from_collaborator_id: owner.id,
      to_collaborator_id: counterpart.id as string,
      text,
      workspace_id: owner.workspace_id,
    });

    notifyMessage({
      fromName: owner.name,
      recipientRole: 'collaborator',
      recipientCollaboratorId: counterpart.id as string,
      text,
    }).catch(e => console.error('notifyMessage(collaborator) failed:', e));

    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error('POST owner message error:', err);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getCollaboratorWithAccess, updateCollaborator, deleteCollaborator } from '@/lib/team-db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const data = await getCollaboratorWithAccess(id);
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    console.error('GET collaborator error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const fields = await req.json();
    const collaborator = await updateCollaborator(id, fields);
    if (!collaborator) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(collaborator);
  } catch (err) {
    console.error('PATCH collaborator error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteCollaborator(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE collaborator error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

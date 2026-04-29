import { NextRequest, NextResponse } from 'next/server';
import { deleteEditorAssignment, updateEditorAssignment } from '@/lib/editor-db';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; assignmentId: string }> }) {
  try {
    const { assignmentId } = await params;
    const fields = await req.json();
    const a = await updateEditorAssignment(assignmentId, fields);
    if (!a) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(a);
  } catch (err) {
    console.error('PATCH editor assignment error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; assignmentId: string }> }) {
  try {
    const { assignmentId } = await params;
    await deleteEditorAssignment(assignmentId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE editor assignment error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

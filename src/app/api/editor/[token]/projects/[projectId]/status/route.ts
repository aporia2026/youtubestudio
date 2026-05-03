import { NextRequest, NextResponse } from 'next/server';
import { getEditorByPersonalToken } from '@/lib/team-db';
import { getEditorAssignment, updateEditorAssignment } from '@/lib/editor-db';

// Statuses the editor can move themselves between. Owner-only states
// (`approved`, `completed`) stay out of reach — an editor can't approve
// their own work.
const EDITOR_ALLOWED_STATUSES = new Set(['assigned', 'editing', 'submitted']);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ token: string; projectId: string }> },
) {
  try {
    const { token, projectId } = await params;
    const editor = await getEditorByPersonalToken(token);
    if (!editor) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const assignment = await getEditorAssignment(projectId, editor.id);
    if (!assignment) return NextResponse.json({ error: 'Not assigned to this project' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const status = typeof body?.status === 'string' ? body.status : null;
    if (!status || !EDITOR_ALLOWED_STATUSES.has(status)) {
      return NextResponse.json(
        { error: 'status must be one of: assigned, editing, submitted' },
        { status: 400 },
      );
    }

    const updated = await updateEditorAssignment(assignment.id, { status });
    return NextResponse.json({ assignment: updated });
  } catch (err) {
    console.error('PATCH editor status error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

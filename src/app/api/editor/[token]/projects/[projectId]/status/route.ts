import { NextRequest, NextResponse } from 'next/server';
import { getEditorByPersonalToken } from '@/lib/team-db';
import { getEditorAssignment, updateEditorAssignment } from '@/lib/editor-db';
import { logger } from '@/lib/logger';

// Statuses the editor can move themselves between. `approved` stays
// owner-only (an editor can't approve their own work) — but `completed`
// is fair game so editors can mark a piece as Done from their kanban
// without waiting for owner approval. Owner-side `approved` also lands
// in the kanban "Done" column automatically since both statuses share
// that bucket.
const EDITOR_ALLOWED_STATUSES = new Set(['assigned', 'editing', 'submitted', 'completed']);

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
        { error: 'status must be one of: assigned, editing, submitted, completed' },
        { status: 400 },
      );
    }

    const updated = await updateEditorAssignment(assignment.id, { status });
    return NextResponse.json({ assignment: updated });
  } catch (err) {
    logger.error('PATCH editor status error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

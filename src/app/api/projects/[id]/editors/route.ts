import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { createEditorAssignment, getEditorAssignmentsForProject } from '@/lib/editor-db';
import { notifyEditorAssigned } from '@/lib/notify';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const list = await getEditorAssignmentsForProject(id);
    return NextResponse.json(list);
  } catch (err) {
    console.error('GET project editors error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const body = await req.json();
    const { editor_id, editor_notes, deadline } = body;
    if (!editor_id) return NextResponse.json({ error: 'editor_id required' }, { status: 400 });
    const assignment = await createEditorAssignment({
      project_id: projectId,
      editor_id,
      editor_notes,
      deadline,
    });

    // Fire-and-forget: notify editor with dashboard URL
    sql`SELECT title FROM projects WHERE id = ${projectId}`.then(r => {
      const title = r.rows[0]?.title;
      if (!title) return;
      notifyEditorAssigned({
        editorId: editor_id,
        projectTitle: title,
        editorNotes: editor_notes,
        deadline,
      }).catch(e => console.error('notifyEditorAssigned failed:', e));
    }).catch(() => {});

    return NextResponse.json(assignment, { status: 201 });
  } catch (err) {
    console.error('POST project editor error:', err);
    return NextResponse.json({ error: 'Failed to assign editor' }, { status: 500 });
  }
}

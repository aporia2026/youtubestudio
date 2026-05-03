import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { createEditorAssignment, getEditorAssignmentsForProject } from '@/lib/editor-db';
import { notifyEditorAssigned } from '@/lib/notify';
import { logger } from '@/lib/logger';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const list = await getEditorAssignmentsForProject(id);
    return NextResponse.json(list);
  } catch (err) {
    logger.error('GET project editors error', { detail: err instanceof Error ? err.message : String(err) });
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
      }).catch(e => logger.error('notifyEditorAssigned failed', { detail: e instanceof Error ? e.message : String(e) }));
    }).catch(() => {});

    return NextResponse.json(assignment, { status: 201 });
  } catch (err) {
    logger.error('POST project editor error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to assign editor' }, { status: 500 });
  }
}

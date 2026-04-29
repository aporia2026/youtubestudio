import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getEditorByPersonalToken } from '@/lib/team-db';
import {
  getEditorAssignmentsForEditor,
  ensureEditorAssignmentFromReviewLink,
  getReviewOnlyEntriesForEditor,
} from '@/lib/editor-db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const editor = await getEditorByPersonalToken(token);
    if (!editor) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    // Backfill: if this editor has any review_share_links that don't have a
    // matching editor_assignment but DO have a resolvable main-project link,
    // create the assignment now. This catches review links given before the
    // auto-create wiring landed (i.e. existing data).
    try {
      const { rows } = await sql`
        SELECT s.project_id AS review_project_id
        FROM review_share_links s
        WHERE s.collaborator_id = ${editor.id}
          AND NOT EXISTS (
            SELECT 1 FROM editor_assignments ea
            WHERE ea.editor_id = ${editor.id}
              AND ea.review_project_id = s.project_id
          )
      `;
      for (const row of rows) {
        await ensureEditorAssignmentFromReviewLink(row.review_project_id, editor.id);
      }
    } catch (err) {
      console.error('editor dashboard backfill error:', err);
    }

    const [assignments, reviewOnly] = await Promise.all([
      getEditorAssignmentsForEditor(editor.id),
      getReviewOnlyEntriesForEditor(editor.id),
    ]);

    return NextResponse.json({
      editor: {
        id: editor.id,
        name: editor.name,
        email: editor.email,
        color: editor.color,
      },
      assignments,
      reviewOnly,
    });
  } catch (err) {
    console.error('GET editor dashboard error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

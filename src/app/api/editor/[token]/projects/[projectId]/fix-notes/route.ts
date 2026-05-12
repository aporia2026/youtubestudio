import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getEditorByPersonalToken } from '@/lib/team-db';
import { getEditorAssignment } from '@/lib/editor-db';
import { notifyCommentResolvedToOwner } from '@/lib/notify';
import { logger } from '@/lib/logger';

/**
 * Editor submits "what I fixed" notes when uploading a corrected version.
 *
 * For each note we create a regular comment on the NEW version, with
 * `fix_for_comment_id` pointing back to the original feedback comment.
 * That makes the fix note appear on the new version's timeline (so the
 * owner sees what changed at the same timestamp), while still being
 * linkable back to the original feedback.
 *
 * Optionally also marks the original comment as resolved — most of the
 * time the editor IS saying "this is fixed", so we default that to true
 * on the client and the user can uncheck per-row.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string; projectId: string }> },
) {
  try {
    const { token, projectId } = await params;
    const editor = await getEditorByPersonalToken(token);
    if (!editor) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const assignment = await getEditorAssignment(projectId, editor.id);
    if (!assignment) return NextResponse.json({ error: 'Not assigned to this project' }, { status: 403 });
    if (!assignment.review_project_id) {
      return NextResponse.json({ error: 'Project has no review project' }, { status: 400 });
    }

    const body = await req.json();
    const versionId = body.versionId as string;
    const notes = (body.notes ?? []) as Array<{ commentId: string; text: string; resolveOriginal?: boolean }>;
    if (!versionId || !Array.isArray(notes) || notes.length === 0) {
      return NextResponse.json({ error: 'versionId + non-empty notes required' }, { status: 400 });
    }

    // Verify the destination version belongs to this editor's review project.
    const { rows: vRows } = await sql`
      SELECT id, version_number FROM review_versions WHERE id = ${versionId} AND project_id = ${assignment.review_project_id} LIMIT 1
    `;
    if (!vRows[0]) {
      return NextResponse.json({ error: 'Version not in this project' }, { status: 403 });
    }

    const created: unknown[] = [];
    for (const note of notes) {
      const text = (note.text ?? '').trim();
      if (!text) continue;
      // Look up the original comment to copy timestamp + verify scope.
      const { rows: origRows } = await sql`
        SELECT c.id, c.timestamp_ms, c.end_timestamp_ms, c.text AS original_text, v.project_id
        FROM review_comments c
        JOIN review_versions v ON v.id = c.version_id
        WHERE c.id = ${note.commentId}
        LIMIT 1
      `;
      const orig = origRows[0];
      if (!orig || orig.project_id !== assignment.review_project_id) continue;

      // workspace_id is NOT NULL on review_comments since migration 0013 —
      // copy it from the parent review_version. author_role is always
      // 'editor' here by construction (this route is guarded to editor
      // assignments) so the inbox can group it correctly.
      const { rows: insertRows } = await sql`
        INSERT INTO review_comments
          (version_id, timestamp_ms, end_timestamp_ms, text, author_name, author_color, author_role, fix_for_comment_id, workspace_id)
        SELECT ${versionId}::uuid, ${orig.timestamp_ms}, ${orig.end_timestamp_ms},
               ${text}, ${editor.name}, ${editor.color || '#22c55e'},
               'editor',
               ${orig.id}::uuid, v.workspace_id
          FROM review_versions v WHERE v.id = ${versionId}::uuid
        RETURNING *
      `;
      created.push(insertRows[0]);

      if (note.resolveOriginal) {
        await sql`
          UPDATE review_comments
          SET resolved = true, resolved_by = ${editor.name}, resolved_at = NOW()
          WHERE id = ${note.commentId}
        `;
        // Notify owner asynchronously so the response isn't blocked.
        const { rows: pRows } = await sql`SELECT title FROM review_projects WHERE id = ${assignment.review_project_id} LIMIT 1`;
        notifyCommentResolvedToOwner({
          projectId: assignment.review_project_id,
          projectTitle: pRows[0]?.title || 'a project',
          resolverName: editor.name,
          commentText: orig.original_text,
          versionNumber: vRows[0].version_number,
          versionId,
          timestampMs: orig.timestamp_ms,
        }).catch(e => logger.error('notifyCommentResolvedToOwner failed', { detail: e instanceof Error ? e.message : String(e) }));
      }
    }

    return NextResponse.json({ created: created.length });
  } catch (err) {
    logger.error('POST fix-notes error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to save fix notes' }, { status: 500 });
  }
}

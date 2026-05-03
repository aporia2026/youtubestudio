import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getEditorByPersonalToken } from '@/lib/team-db';
import { getEditorAssignment } from '@/lib/editor-db';
import { logger } from '@/lib/logger';

/**
 * Returns the unresolved (top-level) comments from the version JUST BEFORE
 * the given `versionId` so the editor's "what did you fix?" modal can
 * pre-populate one row per piece of feedback. Resolved comments are skipped
 * — the editor doesn't need to write a fix note for something already done.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string; projectId: string }> },
) {
  try {
    const { token, projectId } = await params;
    const editor = await getEditorByPersonalToken(token);
    if (!editor) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const assignment = await getEditorAssignment(projectId, editor.id);
    if (!assignment || !assignment.review_project_id) {
      return NextResponse.json({ error: 'Not assigned to a review project' }, { status: 403 });
    }

    const versionId = req.nextUrl.searchParams.get('versionId');
    if (!versionId) return NextResponse.json({ error: 'versionId required' }, { status: 400 });

    // Confirm the version belongs to this review project, and find the
    // immediately-previous version (highest version_number that's lower).
    const { rows: vRows } = await sql`
      SELECT version_number FROM review_versions
      WHERE id = ${versionId} AND project_id = ${assignment.review_project_id}
      LIMIT 1
    `;
    if (!vRows[0]) return NextResponse.json({ error: 'Version not in this project' }, { status: 403 });

    const { rows: prev } = await sql`
      SELECT id, version_number FROM review_versions
      WHERE project_id = ${assignment.review_project_id} AND version_number < ${vRows[0].version_number}
      ORDER BY version_number DESC
      LIMIT 1
    `;
    if (!prev[0]) return NextResponse.json({ previousVersion: null, comments: [] });

    const { rows: comments } = await sql`
      SELECT id, timestamp_ms, end_timestamp_ms, text, author_name, author_color, drawing_thumbnail_url
      FROM review_comments
      WHERE version_id = ${prev[0].id}
        AND resolved = false
        AND parent_id IS NULL
        AND fix_for_comment_id IS NULL
      ORDER BY timestamp_ms ASC, created_at ASC
    `;

    return NextResponse.json({
      previousVersion: { id: prev[0].id, version_number: prev[0].version_number },
      comments,
    });
  } catch (err) {
    logger.error('GET previous-comments error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

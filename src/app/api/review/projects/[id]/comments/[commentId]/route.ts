import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { resolveComment, unresolveComment } from '@/lib/review-db';
import { notifyCommentResolved } from '@/lib/notify';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    const { id: projectId, commentId } = await params;

    // Verify comment belongs to this project
    const { rows } = await sql`
      SELECT 1 FROM review_comments c
      JOIN review_versions v ON v.id = c.version_id
      WHERE c.id = ${commentId} AND v.project_id = ${projectId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Comment not found in this project' }, { status: 403 });
    }

    const { resolved, author_name } = await req.json();

    let comment;
    if (resolved) {
      comment = await resolveComment(commentId, author_name || 'Owner');
    } else {
      comment = await unresolveComment(commentId);
    }

    if (!comment) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });

    // Fire-and-forget: notify the original commenter that their comment was resolved.
    // We map author_name back to a collaborator via the project's share links.
    if (resolved && comment.author_name) {
      sql`
        SELECT DISTINCT c.id AS collaborator_id, p.title AS project_title
        FROM review_share_links s
        JOIN collaborators c ON c.id = s.collaborator_id
        JOIN review_projects p ON p.id = s.project_id
        WHERE s.project_id = ${projectId} AND c.name = ${comment.author_name}
        LIMIT 1
      `.then(r => {
        const row = r.rows[0];
        if (!row) return;
        notifyCommentResolved({
          projectId,
          projectTitle: row.project_title,
          collaboratorId: row.collaborator_id,
          commentText: comment.text,
          resolverName: author_name || 'Owner',
        }).catch(e => console.error('notifyCommentResolved failed:', e));
      }).catch(() => {});
    }

    return NextResponse.json(comment);
  } catch (err) {
    console.error('PATCH owner comment error:', err);
    return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
  }
}

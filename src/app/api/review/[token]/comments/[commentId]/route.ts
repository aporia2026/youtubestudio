import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken, resolveComment, unresolveComment } from '@/lib/review-db';
import { notifyCommentResolvedToOwner } from '@/lib/notify';

/**
 * Token-side comment mutation.
 *
 * Editors and narrators tied to a share link (collaborator role: `editor` or
 * `narrator`) can resolve/unresolve comments. View-only and plain-reviewer
 * collaborators cannot — they should leave a reply instead. On every
 * resolution we notify the owner (who is the one who actually needs to know
 * whether feedback has been addressed).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string; commentId: string }> }) {
  try {
    const { token, commentId } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });
    if (link.permission === 'view-only') {
      return NextResponse.json({ error: 'View-only access' }, { status: 403 });
    }

    // Find the collaborator behind this share link and check they're allowed
    // to resolve. We accept editor + narrator roles (single OR multi) but not
    // generic reviewer/client — those should leave a reply, not flip state.
    if (!link.collaborator_id) {
      return NextResponse.json({ error: 'Anonymous links cannot resolve comments' }, { status: 403 });
    }
    const { rows: collabRows } = await sql`
      SELECT id, name, role, roles FROM collaborators WHERE id = ${link.collaborator_id} LIMIT 1
    `;
    const collab = collabRows[0];
    if (!collab) {
      return NextResponse.json({ error: 'Collaborator not found' }, { status: 403 });
    }
    const allRoles: string[] = Array.isArray(collab.roles) && collab.roles.length > 0
      ? collab.roles
      : (collab.role ? [collab.role] : []);
    const canResolve = allRoles.includes('editor') || allRoles.includes('narrator');
    if (!canResolve) {
      return NextResponse.json({
        error: 'Only editors and narrators can resolve comments. Leave a reply instead.',
      }, { status: 403 });
    }

    // Verify the comment belongs to this share link's project so a token
    // can't be used to mutate comments on a different project.
    const { rows: ownerRows } = await sql`
      SELECT v.project_id, v.id AS version_id, v.version_number
      FROM review_comments c
      JOIN review_versions v ON v.id = c.version_id
      WHERE c.id = ${commentId}
      LIMIT 1
    `;
    const owner = ownerRows[0];
    if (!owner || owner.project_id !== link.project_id) {
      return NextResponse.json({ error: 'Comment not found in this project' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const resolved = !!body.resolved;
    const resolverName = (body.author_name as string | undefined) || collab.name || 'Collaborator';

    const comment = resolved
      ? await resolveComment(commentId, resolverName)
      : await unresolveComment(commentId);
    if (!comment) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });

    // Fire-and-forget: tell the owner an editor/narrator marked something
    // resolved. We only notify on resolve, not unresolve — flip-flopping
    // shouldn't spam the owner's inbox.
    if (resolved) {
      const { rows: projectRows } = await sql`
        SELECT title FROM review_projects WHERE id = ${link.project_id} LIMIT 1
      `;
      const projectTitle = projectRows[0]?.title || 'a project';
      notifyCommentResolvedToOwner({
        projectId: link.project_id,
        projectTitle,
        resolverName,
        commentText: comment.text,
        versionNumber: owner.version_number,
        versionId: owner.version_id,
        timestampMs: comment.timestamp_ms,
      }).catch(e => console.error('notifyCommentResolvedToOwner failed:', e));
    }

    return NextResponse.json(comment);
  } catch (err) {
    console.error('PATCH token comment error:', err);
    return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
  }
}

/**
 * Token-side delete — a collaborator can delete THEIR OWN comments
 * (matched on author_name), nothing else. The owner has a separate route
 * at /api/review/projects/[id]/comments/[commentId] that can delete any
 * comment on the project.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ token: string; commentId: string }> }) {
  try {
    const { token, commentId } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });
    if (link.permission === 'view-only') {
      return NextResponse.json({ error: 'View-only access' }, { status: 403 });
    }

    // The author identity comes from a query param so we don't need a body
    // (DELETE bodies are awkward across fetch implementations).
    const authorName = req.nextUrl.searchParams.get('author_name');
    if (!authorName) return NextResponse.json({ error: 'author_name required' }, { status: 400 });

    const { rows } = await sql`
      SELECT c.author_name FROM review_comments c
      JOIN review_versions v ON v.id = c.version_id
      WHERE c.id = ${commentId} AND v.project_id = ${link.project_id}
      LIMIT 1
    `;
    const found = rows[0];
    if (!found) return NextResponse.json({ error: 'Comment not found in this project' }, { status: 403 });
    if (found.author_name !== authorName) {
      return NextResponse.json({ error: 'You can only delete your own comments' }, { status: 403 });
    }
    await sql`DELETE FROM review_comments WHERE id = ${commentId}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE token comment error:', err);
    return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 });
  }
}

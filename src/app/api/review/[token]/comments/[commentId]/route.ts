import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken } from '@/lib/review-db';

/**
 * Public/token-based comment mutation is disabled for resolve/unresolve —
 * only the owner can do that (see /api/review/projects/[id]/comments/[commentId]).
 */
export async function PATCH(_req: NextRequest) {
  return NextResponse.json(
    { error: 'Only the project owner can resolve comments.' },
    { status: 403 },
  );
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

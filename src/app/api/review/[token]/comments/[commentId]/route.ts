import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getShareLinkByToken, resolveComment, unresolveComment } from '@/lib/review-db';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string; commentId: string }> }) {
  try {
    const { token, commentId } = await params;
    const link = await getShareLinkByToken(token);
    if (!link) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });

    if (link.permission === 'view-only') {
      return NextResponse.json({ error: 'View-only access' }, { status: 403 });
    }

    // Verify comment belongs to this project
    const { rows: ownerCheck } = await sql`
      SELECT 1 FROM review_comments c
      JOIN review_versions v ON v.id = c.version_id
      WHERE c.id = ${commentId} AND v.project_id = ${link.project_id}
      LIMIT 1
    `;
    if (ownerCheck.length === 0) {
      return NextResponse.json({ error: 'Comment not found in this project' }, { status: 403 });
    }

    const { resolved, author_name } = await req.json();

    let comment;
    if (resolved) {
      comment = await resolveComment(commentId, author_name || 'unknown');
    } else {
      comment = await unresolveComment(commentId);
    }

    if (!comment) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    return NextResponse.json(comment);
  } catch (err) {
    console.error('PATCH comment error:', err);
    return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
  }
}

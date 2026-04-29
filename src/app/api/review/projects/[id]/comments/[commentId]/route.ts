import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { resolveComment, unresolveComment } from '@/lib/review-db';

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
    return NextResponse.json(comment);
  } catch (err) {
    console.error('PATCH owner comment error:', err);
    return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
  }
}

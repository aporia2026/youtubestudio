import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getAssignmentByToken } from '@/lib/narrator-db';
import { logger } from '@/lib/logger';

/** Token-side delete — narrator can only delete their own comments. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ token: string; commentId: string }> }) {
  try {
    const { token, commentId } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const authorName = req.nextUrl.searchParams.get('author_name');
    if (!authorName) return NextResponse.json({ error: 'author_name required' }, { status: 400 });

    const { rows } = await sql`
      SELECT author_name, author_role FROM narrator_comments
      WHERE id = ${commentId} AND assignment_id = ${assignment.id}
      LIMIT 1
    `;
    const found = rows[0];
    if (!found) return NextResponse.json({ error: 'Comment not found in this assignment' }, { status: 403 });
    // The narrator can only delete comments they themselves authored, never owner ones.
    if (found.author_role !== 'narrator' || found.author_name !== authorName) {
      return NextResponse.json({ error: 'You can only delete your own comments' }, { status: 403 });
    }
    await sql`DELETE FROM narrator_comments WHERE id = ${commentId}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('DELETE narrator token comment error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 });
  }
}

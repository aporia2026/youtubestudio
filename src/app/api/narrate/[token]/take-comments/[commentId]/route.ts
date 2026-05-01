import { NextRequest, NextResponse } from 'next/server';
import {
  getAssignmentByToken,
  getTakeCommentScope,
  resolveTakeComment,
  unresolveTakeComment,
  deleteTakeComment,
} from '@/lib/narrator-db';

export const runtime = 'nodejs';

/** Token-side: narrator can resolve/unresolve their own thread or any thread
 *  on a take owned by their assignment (parallels editor "I fixed this" flow). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string; commentId: string }> }) {
  try {
    const { token, commentId } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const scope = await getTakeCommentScope(commentId);
    if (!scope || scope.assignment_id !== assignment.id) {
      return NextResponse.json({ error: 'Comment not in this assignment' }, { status: 403 });
    }

    const { resolved } = await req.json();
    const comment = resolved
      ? await resolveTakeComment(commentId, assignment.narrator_name || 'Narrator')
      : await unresolveTakeComment(commentId);
    if (!comment) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    return NextResponse.json(comment);
  } catch (err) {
    console.error('PATCH token take comment error:', err);
    return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
  }
}

/** Token-side: narrator can only delete comments they themselves authored. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ token: string; commentId: string }> }) {
  try {
    const { token, commentId } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const scope = await getTakeCommentScope(commentId);
    if (!scope || scope.assignment_id !== assignment.id) {
      return NextResponse.json({ error: 'Comment not in this assignment' }, { status: 403 });
    }

    if (scope.author_role !== 'narrator' || scope.author_name !== assignment.narrator_name) {
      return NextResponse.json({ error: 'You can only delete your own comments' }, { status: 403 });
    }

    await deleteTakeComment(commentId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE token take comment error:', err);
    return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import {
  getTakeCommentScope,
  resolveTakeComment,
  unresolveTakeComment,
  deleteTakeComment,
} from '@/lib/narrator-db';

export const runtime = 'nodejs';

/** Owner-side: resolve / unresolve a take comment. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ commentId: string }> }) {
  try {
    const { commentId } = await params;
    const scope = await getTakeCommentScope(commentId);
    if (!scope) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });

    const { resolved, author_name } = await req.json();
    const comment = resolved
      ? await resolveTakeComment(commentId, author_name || 'Owner')
      : await unresolveTakeComment(commentId);
    if (!comment) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    return NextResponse.json(comment);
  } catch (err) {
    console.error('PATCH owner take comment error:', err);
    return NextResponse.json({ error: 'Failed to update comment' }, { status: 500 });
  }
}

/** Owner-side: delete any comment regardless of author. CASCADE drops replies. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ commentId: string }> }) {
  try {
    const { commentId } = await params;
    const scope = await getTakeCommentScope(commentId);
    if (!scope) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    await deleteTakeComment(commentId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE owner take comment error:', err);
    return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 });
  }
}

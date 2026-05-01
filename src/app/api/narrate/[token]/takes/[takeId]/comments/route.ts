import { NextRequest, NextResponse } from 'next/server';
import {
  getAssignmentByToken,
  getTakeAssignmentScope,
  getTakeComments,
  createTakeComment,
} from '@/lib/narrator-db';

export const runtime = 'nodejs';

/** Token-side: narrator lists comments on one of their takes. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string; takeId: string }> }) {
  try {
    const { token, takeId } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const scope = await getTakeAssignmentScope(takeId);
    if (!scope || scope.assignment_id !== assignment.id) {
      return NextResponse.json({ error: 'Take not found in this assignment' }, { status: 403 });
    }

    const comments = await getTakeComments(takeId);
    return NextResponse.json(comments);
  } catch (err) {
    console.error('GET token take comments error:', err);
    return NextResponse.json({ error: 'Failed to load comments' }, { status: 500 });
  }
}

/** Token-side: narrator posts a reply or new comment. author_role is forced to 'narrator'. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string; takeId: string }> }) {
  try {
    const { token, takeId } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const scope = await getTakeAssignmentScope(takeId);
    if (!scope || scope.assignment_id !== assignment.id) {
      return NextResponse.json({ error: 'Take not found in this assignment' }, { status: 403 });
    }

    const body = await req.json();
    const { timestamp_ms, end_timestamp_ms, text, author_color, parent_id } = body;
    if (timestamp_ms == null || !text?.trim()) {
      return NextResponse.json({ error: 'timestamp_ms and text are required' }, { status: 400 });
    }

    const comment = await createTakeComment({
      take_id: takeId,
      timestamp_ms,
      end_timestamp_ms: typeof end_timestamp_ms === 'number' ? end_timestamp_ms : null,
      text: text.trim(),
      // Identity is the narrator on this assignment — the token vouches for it.
      author_name: assignment.narrator_name || 'Narrator',
      author_color: author_color || assignment.narrator_color || '#7c3aed',
      author_role: 'narrator',
      parent_id: parent_id || null,
    });
    return NextResponse.json(comment, { status: 201 });
  } catch (err) {
    console.error('POST token take comment error:', err);
    return NextResponse.json({ error: 'Failed to create comment' }, { status: 500 });
  }
}

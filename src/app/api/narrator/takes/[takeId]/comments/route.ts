import { NextRequest, NextResponse } from 'next/server';
import {
  createTakeComment,
  getTakeComments,
  getTakeAssignmentScope,
} from '@/lib/narrator-db';

export const runtime = 'nodejs';

/** Owner-side: list every threaded comment on a take. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ takeId: string }> }) {
  try {
    const { takeId } = await params;
    const scope = await getTakeAssignmentScope(takeId);
    if (!scope) return NextResponse.json({ error: 'Take not found' }, { status: 404 });
    const comments = await getTakeComments(takeId);
    return NextResponse.json(comments);
  } catch (err) {
    console.error('GET take comments (owner) error:', err);
    return NextResponse.json({ error: 'Failed to load comments' }, { status: 500 });
  }
}

/** Owner-side: post a new comment on a take. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ takeId: string }> }) {
  try {
    const { takeId } = await params;
    const scope = await getTakeAssignmentScope(takeId);
    if (!scope) return NextResponse.json({ error: 'Take not found' }, { status: 404 });

    const body = await req.json();
    const { timestamp_ms, end_timestamp_ms, text, author_name, author_color, parent_id } = body;
    if (timestamp_ms == null || !text?.trim() || !author_name?.trim()) {
      return NextResponse.json({ error: 'timestamp_ms, text, and author_name are required' }, { status: 400 });
    }

    const comment = await createTakeComment({
      take_id: takeId,
      timestamp_ms,
      end_timestamp_ms: typeof end_timestamp_ms === 'number' ? end_timestamp_ms : null,
      text: text.trim(),
      author_name: author_name.trim(),
      author_color: author_color || '#06b6d4',
      author_role: 'owner',
      parent_id: parent_id || null,
    });
    return NextResponse.json(comment, { status: 201 });
  } catch (err) {
    console.error('POST take comment (owner) error:', err);
    return NextResponse.json({ error: 'Failed to create comment' }, { status: 500 });
  }
}

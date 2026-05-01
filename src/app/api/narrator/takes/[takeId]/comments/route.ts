import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import {
  createTakeComment,
  getTakeComments,
  getTakeAssignmentScope,
} from '@/lib/narrator-db';
import { notifyOwnerTakeComment } from '@/lib/notify';

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

    // Fire-and-forget notify the narrator. Looks up the assignment +
    // section + narrator metadata in one round-trip so the email link
    // points at the right portal. Doesn't block the response.
    sql`
      SELECT
        s.label AS section_label,
        s.section_number,
        t.take_number,
        a.id AS assignment_id,
        a.share_token,
        a.project_id,
        p.title AS project_title,
        n.id AS narrator_id,
        n.personal_token AS narrator_personal_token
      FROM narrator_takes t
      JOIN narrator_sections s ON s.id = t.section_id
      JOIN narrator_assignments a ON a.id = s.assignment_id
      LEFT JOIN projects p ON p.id = a.project_id
      LEFT JOIN collaborators n ON n.id = a.narrator_id
      WHERE t.id = ${takeId}
      LIMIT 1
    `.then(r => {
      const row = r.rows[0];
      if (!row || !row.narrator_id) return;
      notifyOwnerTakeComment({
        narratorId: row.narrator_id as string,
        narratorPersonalToken: (row.narrator_personal_token as string | null) || null,
        narratorShareToken: (row.share_token as string | null) || null,
        ownerName: author_name.trim(),
        projectId: (row.project_id as string | null) || null,
        projectTitle: (row.project_title as string | null) || 'project',
        sectionLabel: (row.section_label as string | null) || `Section ${row.section_number}`,
        takeNumber: row.take_number as number,
        timestampMs: comment.timestamp_ms,
        endTimestampMs: comment.end_timestamp_ms,
        text: comment.text,
      }).catch(e => console.error('notifyOwnerTakeComment failed:', e));
    }).catch(() => {});

    return NextResponse.json(comment, { status: 201 });
  } catch (err) {
    console.error('POST take comment (owner) error:', err);
    return NextResponse.json({ error: 'Failed to create comment' }, { status: 500 });
  }
}

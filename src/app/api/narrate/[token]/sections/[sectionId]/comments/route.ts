import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getAssignmentByToken, createNarratorComment } from '@/lib/narrator-db';
import { notifyNarratorComment } from '@/lib/notify';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string; sectionId: string }> }) {
  try {
    const { token, sectionId } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    // Verify section belongs to this assignment
    const { rows: sectionCheck } = await sql`
      SELECT 1 FROM narrator_sections WHERE id = ${sectionId} AND assignment_id = ${assignment.id} LIMIT 1
    `;
    if (sectionCheck.length === 0) {
      return NextResponse.json({ error: 'Section not found in this assignment' }, { status: 403 });
    }

    const { text, author_name } = await req.json();
    if (!text?.trim() || !author_name?.trim()) {
      return NextResponse.json({ error: 'text and author_name required' }, { status: 400 });
    }

    const comment = await createNarratorComment({
      assignment_id: assignment.id,
      section_id: sectionId,
      text: text.trim(),
      author_name: author_name.trim(),
      author_role: 'narrator',
    });

    // Fire-and-forget: notify owner
    notifyNarratorComment({
      narratorName: author_name.trim(),
      projectId: assignment.project_id,
      projectTitle: assignment.project_title || 'project',
      text: text.trim(),
    }).catch(e => logger.error('notifyNarratorComment failed', { detail: e instanceof Error ? e.message : String(e) }));

    return NextResponse.json(comment, { status: 201 });
  } catch (err) {
    logger.error('comment error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to post comment' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { updateSection, createNarratorComment } from '@/lib/narrator-db';
import { notifyRetakeRequested } from '@/lib/notify';
import { logger } from '@/lib/logger';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; sectionId: string }> }) {
  try {
    const { id: assignmentId, sectionId } = await params;
    const body = await req.json();
    const { status, director_notes, pronunciation_notes, approved_take_id, retake_notes } = body;

    // If requesting retake, also create a comment
    if (status === 'retake' && retake_notes) {
      await createNarratorComment({
        assignment_id: assignmentId,
        section_id: sectionId,
        text: `Retake requested: ${retake_notes}`,
        author_name: 'Owner',
        author_role: 'owner',
      });
    }

    const section = await updateSection(sectionId, {
      status,
      director_notes,
      pronunciation_notes,
      approved_take_id,
    });

    if (!section) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Fire-and-forget: notify narrator on retake
    if (status === 'retake') {
      sql`
        SELECT a.narrator_id, a.share_token, s.label
        FROM narrator_assignments a
        JOIN narrator_sections s ON s.id = ${sectionId}
        WHERE a.id = ${assignmentId}
        LIMIT 1
      `.then(r => {
        const row = r.rows[0];
        if (!row?.narrator_id) return;
        notifyRetakeRequested({
          narratorId: row.narrator_id,
          shareToken: row.share_token,
          sectionLabel: row.label || 'a section',
          notes: retake_notes,
        }).catch(e => logger.error('notifyRetakeRequested failed', { detail: e instanceof Error ? e.message : String(e) }));
      }).catch(() => {});
    }

    return NextResponse.json(section);
  } catch (err) {
    logger.error('PUT section error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update section' }, { status: 500 });
  }
}

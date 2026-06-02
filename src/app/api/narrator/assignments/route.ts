import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { createAssignment, createSection, listAllAssignments } from '@/lib/narrator-db';
import { splitScriptIntoSections } from '@/lib/narrator-utils';
import { notifyAssignmentReceived } from '@/lib/notify';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const assignments = await listAllAssignments();
    return NextResponse.json(assignments);
  } catch (err) {
    logger.error('GET assignments error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to list assignments' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { project_id, script_id, narrator_id, script_text, director_notes, wpm, script_version, deadline, sections: customSections } = body;

    if (!project_id || !script_id || !narrator_id || !script_text) {
      return NextResponse.json({ error: 'project_id, script_id, narrator_id, and script_text are required' }, { status: 400 });
    }

    // Reject when an active assignment already exists for this project.
    //
    // Defence-in-depth with migration 0112's unique partial index — the index
    // would also block the INSERT, but doing the check here lets us return the
    // existing share_token so the AssignDialog can route the owner to the
    // current assignment instead of failing with a generic 500. Statuses
    // outside this set (`approved`, `completed`) are terminal — a new
    // assignment after one of those is a legitimate fresh round.
    const { rows: existingRows } = await sql`
      SELECT id::text AS id, share_token
        FROM narrator_assignments
       WHERE project_id = ${project_id}
         AND status IN ('assigned','received','recording','submitted','revisions')
       LIMIT 1
    `;
    if (existingRows.length > 0) {
      const existing = existingRows[0];
      logger.info('[narrator assign duplicate-blocked]', {
        projectId: project_id,
        existingAssignmentId: existing.id,
      });
      return NextResponse.json(
        {
          error: 'An active narrator assignment already exists for this project',
          existing: { id: existing.id, share_token: existing.share_token },
        },
        { status: 409 },
      );
    }

    // Create assignment
    const assignment = await createAssignment({
      project_id,
      script_id,
      narrator_id,
      director_notes,
      wpm: wpm || 150,
      script_version,
      deadline,
    });

    // Split script into sections (use custom sections if provided, otherwise auto-split)
    const sectionData = customSections || splitScriptIntoSections(script_text, wpm || 150);

    // Create section rows
    for (let i = 0; i < sectionData.length; i++) {
      const s = sectionData[i];
      await createSection({
        assignment_id: assignment.id,
        section_number: i + 1,
        label: s.label,
        script_text: s.script_text,
        director_notes: s.director_notes,
        pronunciation_notes: s.pronunciation_notes,
        emphasis_markers: s.emphasis_markers,
        estimated_duration_seconds: s.estimated_duration_seconds,
      });
    }

    // If a schedule item exists for this script, mark it as recording and
    // record the assignment id in custom_fields so the schedule UI can show
    // a "→ Narrator" badge that deep-links to the right portal.
    try {
      await sql`
        UPDATE schedule_items
        SET status = CASE WHEN status IN ('idea', 'scripting') THEN 'recording' ELSE status END,
            custom_fields = COALESCE(custom_fields, '{}'::jsonb) || jsonb_build_object(
              'narrator_assignment_id', ${assignment.id}::text,
              'narrator_id', ${narrator_id}::text,
              'narrator_share_token', ${assignment.share_token}::text
            ),
            updated_at = NOW(),
            stage_entered_at = CASE WHEN status IN ('idea', 'scripting') THEN NOW() ELSE stage_entered_at END
        WHERE script_id = ${script_id}
      `;
    } catch (e) {
      // Schedule integration is optional — never block assignment creation
      console.warn('schedule_items update on assignment create failed:', e);
    }

    // Fire-and-forget: notify narrator with portal link
    sql`
      SELECT c.name AS narrator_name, p.title AS project_title
      FROM collaborators c, projects p
      WHERE c.id = ${narrator_id} AND p.id = ${project_id}
    `.then(r => {
      const row = r.rows[0];
      if (!row) return;
      notifyAssignmentReceived({
        narratorId: narrator_id,
        narratorName: row.narrator_name || 'Narrator',
        projectTitle: row.project_title || 'project',
        shareToken: assignment.share_token,
        sectionCount: sectionData.length,
        deadline,
      }).catch(e => logger.error('notifyAssignmentReceived failed', { detail: e instanceof Error ? e.message : String(e) }));
    }).catch(() => {});

    return NextResponse.json({ assignment, sectionCount: sectionData.length }, { status: 201 });
  } catch (err) {
    logger.error('POST assignment error', { detail: err instanceof Error ? err.message : String(err) });
    const message = err instanceof Error ? err.message : 'Failed to create assignment';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

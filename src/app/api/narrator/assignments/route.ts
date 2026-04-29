import { NextRequest, NextResponse } from 'next/server';
import { createAssignment, createSection, listAllAssignments } from '@/lib/narrator-db';
import { splitScriptIntoSections } from '@/lib/narrator-utils';

export async function GET() {
  try {
    const assignments = await listAllAssignments();
    return NextResponse.json(assignments);
  } catch (err) {
    console.error('GET assignments error:', err);
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

    return NextResponse.json({ assignment, sectionCount: sectionData.length }, { status: 201 });
  } catch (err) {
    console.error('POST assignment error:', err);
    return NextResponse.json({ error: 'Failed to create assignment' }, { status: 500 });
  }
}

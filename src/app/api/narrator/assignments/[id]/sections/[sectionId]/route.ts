import { NextRequest, NextResponse } from 'next/server';
import { updateSection, createNarratorComment } from '@/lib/narrator-db';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; sectionId: string }> }) {
  try {
    const { sectionId } = await params;
    const body = await req.json();
    const { status, director_notes, pronunciation_notes, approved_take_id, retake_notes } = body;

    // If requesting retake, also create a comment
    if (status === 'retake' && retake_notes) {
      const { id } = await params;
      await createNarratorComment({
        assignment_id: id,
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
    return NextResponse.json(section);
  } catch (err) {
    console.error('PUT section error:', err);
    return NextResponse.json({ error: 'Failed to update section' }, { status: 500 });
  }
}

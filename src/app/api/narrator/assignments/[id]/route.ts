import { NextRequest, NextResponse } from 'next/server';
import { getAssignment, updateAssignment, getSectionsForAssignment, getCommentsForAssignment } from '@/lib/narrator-db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const assignment = await getAssignment(id);
    if (!assignment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const sections = await getSectionsForAssignment(id);
    const comments = await getCommentsForAssignment(id);
    return NextResponse.json({ assignment, sections, comments });
  } catch (err) {
    console.error('GET assignment error:', err);
    return NextResponse.json({ error: 'Failed to get assignment' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const fields = await req.json();
    const assignment = await updateAssignment(id, fields);
    if (!assignment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(assignment);
  } catch (err) {
    console.error('PUT assignment error:', err);
    return NextResponse.json({ error: 'Failed to update assignment' }, { status: 500 });
  }
}

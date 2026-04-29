import { NextRequest, NextResponse } from 'next/server';
import { getAssignmentByToken, updateAssignment } from '@/lib/narrator-db';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    await updateAssignment(assignment.id, { status: 'submitted' });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('submit error:', err);
    return NextResponse.json({ error: 'Failed to submit' }, { status: 500 });
  }
}

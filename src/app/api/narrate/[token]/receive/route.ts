import { NextRequest, NextResponse } from 'next/server';
import { getAssignmentByToken, updateAssignment } from '@/lib/narrator-db';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    if (assignment.status === 'assigned') {
      await updateAssignment(assignment.id, { status: 'received' });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('receive error:', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getAssignmentByToken, getSectionsForAssignment, getCommentsForAssignment } from '@/lib/narrator-db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 });

    // Track access (fire-and-forget)
    sql`UPDATE narrator_assignments SET last_accessed_at = NOW(), access_count = access_count + 1 WHERE share_token = ${token}`.catch(() => {});

    const sections = await getSectionsForAssignment(assignment.id);
    const comments = await getCommentsForAssignment(assignment.id);

    return NextResponse.json({ assignment, sections, comments });
  } catch (err) {
    console.error('GET narrate/[token] error:', err);
    return NextResponse.json({ error: 'Failed to load assignment' }, { status: 500 });
  }
}

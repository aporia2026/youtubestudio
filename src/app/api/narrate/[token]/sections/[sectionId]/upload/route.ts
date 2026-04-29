import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { put } from '@vercel/blob';
import { getAssignmentByToken, createTake, updateAssignment } from '@/lib/narrator-db';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

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

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const narratorNotes = formData.get('narrator_notes') as string | null;

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    if (!file.type.startsWith('audio/')) {
      return NextResponse.json({ error: 'File must be an audio file' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 100MB)' }, { status: 400 });
    }

    const sanitized = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const pathname = `narrator-takes/${assignment.id}/${sectionId}/${Date.now()}-${sanitized}`;
    const blob = await put(pathname, file, { access: 'public' });

    const take = await createTake({
      section_id: sectionId,
      audio_url: blob.url,
      blob_pathname: blob.pathname,
      file_size: file.size,
      narrator_notes: narratorNotes || undefined,
    });

    if (assignment.status === 'received' || assignment.status === 'assigned') {
      await updateAssignment(assignment.id, { status: 'recording' });
    }

    return NextResponse.json(take, { status: 201 });
  } catch (err) {
    console.error('upload take error:', err);
    return NextResponse.json({ error: 'Failed to upload' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getAssignmentByToken, createTake, updateAssignment } from '@/lib/narrator-db';
import { isR2Configured, buildNarrationKey, getNarrationUploadUrl, getNarrationDownloadUrl } from '@/lib/r2';
import { notifyNarratorTake } from '@/lib/notify';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB hard cap
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/flac', 'audio/aac'];

/**
 * Two-step upload to R2 narration bucket:
 *   STEP 1 (POST { fileName, contentType, fileSize, durationSeconds? }):
 *     server reserves a take row + returns { uploadUrl, takeId, r2Key, audioUrl }
 *     client PUTs the file directly to uploadUrl
 *   STEP 2 (PATCH { takeId, durationSeconds }):
 *     optional — client confirms duration after probing the file
 *
 * Falls back gracefully with a 503 if R2 is not configured yet.
 */
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

    if (!isR2Configured()) {
      return NextResponse.json({
        error: 'Cloudflare R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_NARRATION_BUCKET_NAME in your environment.',
        code: 'R2_NOT_CONFIGURED',
      }, { status: 503 });
    }

    const { fileName, contentType, fileSize, narratorNotes, durationSeconds } = await req.json();
    if (!fileName || !contentType) {
      return NextResponse.json({ error: 'fileName and contentType are required' }, { status: 400 });
    }
    if (!ALLOWED_AUDIO_TYPES.includes(contentType)) {
      return NextResponse.json({ error: `Invalid audio type: ${contentType}` }, { status: 400 });
    }
    if (typeof fileSize === 'number' && fileSize > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
    }

    // Reserve a take row first so we know the take_number used in the R2 key
    const placeholderUrl = ''; // will be patched once we know the public/playback URL
    const take = await createTake({
      section_id: sectionId,
      audio_url: placeholderUrl,
      duration_seconds: typeof durationSeconds === 'number' ? durationSeconds : undefined,
      file_size: typeof fileSize === 'number' ? fileSize : undefined,
      narrator_notes: narratorNotes || undefined,
    });

    const r2Key = buildNarrationKey(assignment.id, sectionId, take.take_number, fileName);
    let uploadUrl: string;
    let downloadUrl: string;
    try {
      uploadUrl = await getNarrationUploadUrl(r2Key, contentType);
      downloadUrl = await getNarrationDownloadUrl(r2Key);
    } catch (e) {
      // Roll back the take row if presigning fails
      await sql`DELETE FROM narrator_takes WHERE id = ${take.id}`;
      const msg = e instanceof Error ? e.message : 'Unknown R2 error';
      return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
    }

    // Save the R2 key + audio URL on the take row
    await sql`
      UPDATE narrator_takes
      SET r2_key = ${r2Key}, audio_url = ${downloadUrl}
      WHERE id = ${take.id}
    `;

    // Auto-advance assignment status if this is the narrator's first activity
    if (assignment.status === 'received' || assignment.status === 'assigned') {
      await updateAssignment(assignment.id, { status: 'recording' });
    }

    // Fire-and-forget: notify owner of new take
    sql`SELECT label FROM narrator_sections WHERE id = ${sectionId}`.then(r => {
      const sectionLabel = r.rows[0]?.label || 'a section';
      notifyNarratorTake({
        narratorName: assignment.narrator_name || 'Narrator',
        projectId: assignment.project_id,
        projectTitle: assignment.project_title || 'project',
        sectionLabel,
        takeNumber: take.take_number,
      }).catch(e => console.error('notifyNarratorTake failed:', e));
    }).catch(() => {});

    return NextResponse.json({
      uploadUrl,
      takeId: take.id,
      takeNumber: take.take_number,
      r2Key,
      audioUrl: downloadUrl,
    }, { status: 201 });
  } catch (err) {
    console.error('upload take error:', err);
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to start upload: ${msg}` }, { status: 500 });
  }
}

/** PATCH: client confirms upload completed (sets duration / file size after probing). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string; sectionId: string }> }) {
  try {
    const { token, sectionId } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const { takeId, durationSeconds, fileSize } = await req.json();
    if (!takeId) return NextResponse.json({ error: 'takeId required' }, { status: 400 });

    // Verify the take belongs to a section on this assignment
    const { rows } = await sql`
      SELECT t.id FROM narrator_takes t
      JOIN narrator_sections s ON s.id = t.section_id
      WHERE t.id = ${takeId} AND s.id = ${sectionId} AND s.assignment_id = ${assignment.id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Take not found in this assignment' }, { status: 403 });
    }

    await sql`
      UPDATE narrator_takes
      SET duration_seconds = COALESCE(${typeof durationSeconds === 'number' ? durationSeconds : null}, duration_seconds),
          file_size = COALESCE(${typeof fileSize === 'number' ? fileSize : null}, file_size)
      WHERE id = ${takeId}
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('PATCH take error:', err);
    return NextResponse.json({ error: 'Failed to update take' }, { status: 500 });
  }
}

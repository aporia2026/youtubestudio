import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import {
  getAssignmentByToken,
  createTake,
  ensureFullAudioSection,
  setAssignmentFullAudio,
  updateAssignment,
} from '@/lib/narrator-db';
import {
  isR2Configured,
  buildNarrationKey,
  getNarrationUploadUrl,
  getNarrationDownloadUrl,
} from '@/lib/r2';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_FILE_SIZE = 500 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/wave',
  'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/flac', 'audio/aac',
];

/**
 * STEP 1 (POST { fileName, contentType, fileSize, durationSeconds? }):
 *   reserve a take row in the synthetic "full" section + return a presigned
 *   PUT URL the browser can upload to.
 * STEP 2 (PATCH { takeId, durationSeconds }):
 *   confirm metadata after the client probes the file.
 *
 * The take is identical in shape to a per-section take, so the existing
 * TakeReview / comment APIs work against it without modification.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    if (!isR2Configured()) {
      return NextResponse.json({
        error: 'Cloudflare R2 storage is not configured.',
        code: 'R2_NOT_CONFIGURED',
      }, { status: 503 });
    }

    const { fileName, contentType, fileSize, durationSeconds } = await req.json();
    if (!fileName || !contentType) {
      return NextResponse.json({ error: 'fileName and contentType are required' }, { status: 400 });
    }
    if (!ALLOWED_AUDIO_TYPES.includes(contentType)) {
      return NextResponse.json({ error: `Invalid audio type: ${contentType}` }, { status: 400 });
    }
    if (typeof fileSize === 'number' && fileSize > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
    }

    const sectionId = await ensureFullAudioSection(assignment.id);

    const take = await createTake({
      section_id: sectionId,
      audio_url: '',
      duration_seconds: typeof durationSeconds === 'number' ? durationSeconds : undefined,
      file_size: typeof fileSize === 'number' ? fileSize : undefined,
    });

    const r2Key = buildNarrationKey(assignment.id, sectionId, take.take_number, fileName);
    let uploadUrl: string;
    let downloadUrl: string;
    try {
      uploadUrl = await getNarrationUploadUrl(r2Key, contentType);
      downloadUrl = await getNarrationDownloadUrl(r2Key);
    } catch (e) {
      await sql`DELETE FROM narrator_takes WHERE id = ${take.id}`;
      const msg = e instanceof Error ? e.message : 'Unknown R2 error';
      return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
    }

    await sql`
      UPDATE narrator_takes
      SET r2_key = ${r2Key}, audio_url = ${downloadUrl}
      WHERE id = ${take.id}
    `;

    await setAssignmentFullAudio({
      assignment_id: assignment.id,
      take_id: take.id,
      audio_url: downloadUrl,
      r2_key: r2Key,
      duration_seconds: typeof durationSeconds === 'number' ? durationSeconds : null,
    });

    if (assignment.status === 'received' || assignment.status === 'assigned') {
      await updateAssignment(assignment.id, { status: 'recording' });
    }

    return NextResponse.json({
      uploadUrl,
      takeId: take.id,
      r2Key,
      audioUrl: downloadUrl,
    }, { status: 201 });
  } catch (err) {
    console.error('upload full audio error:', err);
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to start upload: ${msg}` }, { status: 500 });
  }
}

/** PATCH: client confirms upload + duration after probing the local file. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const assignment = await getAssignmentByToken(token);
    if (!assignment) return NextResponse.json({ error: 'Invalid link' }, { status: 404 });

    const { takeId, durationSeconds, fileSize } = await req.json();
    if (!takeId) return NextResponse.json({ error: 'takeId required' }, { status: 400 });

    // Verify the take belongs to this assignment via the section join.
    const { rows } = await sql`
      SELECT t.id FROM narrator_takes t
      JOIN narrator_sections s ON s.id = t.section_id
      WHERE t.id = ${takeId} AND s.assignment_id = ${assignment.id}
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
    if (typeof durationSeconds === 'number') {
      await sql`
        UPDATE narrator_assignments
        SET full_audio_duration_seconds = ${durationSeconds}, updated_at = NOW()
        WHERE id = ${assignment.id}
      `;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('PATCH full audio error:', err);
    return NextResponse.json({ error: 'Failed to update full audio' }, { status: 500 });
  }
}

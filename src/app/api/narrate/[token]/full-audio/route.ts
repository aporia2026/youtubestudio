import { NextRequest, NextResponse, after } from 'next/server';
import { logger } from '@/lib/logger';
import { sql } from '@vercel/postgres';
import {
  getAssignmentByToken,
  createTake,
  ensureFullAudioSection,
  setAssignmentFullAudio,
  updateAssignment,
  getCurrentFullAudio,
  deleteTake,
  resetTakeAlignment,
} from '@/lib/narrator-db';
import {
  isR2Configured,
  buildNarrationKey,
  getNarrationUploadUrl,
  getNarrationDownloadUrl,
  deleteNarrationObject,
} from '@/lib/r2';
import { ALLOWED_AUDIO_MIME_TYPES, resolveAudioMime } from '@/lib/narrator-utils';
import { runAlignmentForAssignment } from '@/lib/alignment';
import { domainErrorResponse } from '@/lib/route-helpers';

export const runtime = 'nodejs';
// The PATCH handler schedules forced alignment via `after()` once the
// upload is confirmed. Forced alignment on a 14-min file takes ~3-4 min
// of ElevenLabs processing — well past the 60s default. Bumping to the
// Pro plan's Fluid Compute cap so the deferred run actually finishes;
// the synchronous PATCH work still returns in <1s.
export const maxDuration = 800;

// Whole-script uploads can be ~90min stereo WAV (~900MB). Per-section uploads
// stay capped at 500MB; this path needs more headroom because the narrator may
// not transcode before submitting.
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

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
    // Resolve before validating: browsers sometimes emit `application/octet-stream`
    // for AIFF / desktop-exported files. The R2 presign uses the resolved mime so
    // the client's PUT must send the same type — see the response below.
    const resolvedContentType = resolveAudioMime(contentType, fileName);
    if (!ALLOWED_AUDIO_MIME_TYPES.includes(resolvedContentType)) {
      return NextResponse.json({ error: `Invalid audio type: ${contentType}` }, { status: 400 });
    }
    if (typeof fileSize === 'number' && fileSize > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 2GB)' }, { status: 400 });
    }

    const sectionId = await ensureFullAudioSection(assignment.id);

    // "Replace" semantics: when a previous full-audio take exists, hard-delete
    // it (and its R2 object + cascaded comments) before reserving a new one.
    // Without this, the previous take row + storage leak forever, and any
    // owner comments on the old take become invisible (the UI loads comments
    // for the *current* full_audio_take_id only). Comment loss is the
    // documented Replace semantic — the alternative is take history with a
    // version selector, which is heavier than this v1 needs.
    const prior = await getCurrentFullAudio(assignment.id);
    if (prior) {
      // R2 cleanup is best-effort: a stale object is just storage cost, not
      // a correctness issue. The DB delete is the load-bearing operation.
      if (prior.r2_key) {
        try { await deleteNarrationObject(prior.r2_key); } catch (e) {
          console.warn('full-audio replace: failed to delete prior R2 object', e);
        }
      }
      try { await deleteTake(prior.take_id); } catch (e) {
        console.warn('full-audio replace: failed to delete prior take row', e);
      }
    }

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
      uploadUrl = await getNarrationUploadUrl(r2Key, resolvedContentType);
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
      // Client must PUT with this exact Content-Type — R2 signed it into the URL.
      contentType: resolvedContentType,
    }, { status: 201 });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'narrate: full-audio upload presign',
      fallbackMessage: 'Could not start upload — please try again.',
    });
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

    // A fresh upload invalidates any prior alignment that was sitting on
    // the (now-deleted) previous take. The new take starts pending by
    // default; this call is safe even if the prior take's row is already
    // gone — it's a no-op when the id doesn't exist.
    await resetTakeAlignment(takeId);

    // Defer alignment via `after()` so the function instance stays alive
    // past the response until the orchestrator finishes (or its own
    // timeout / error path writes a terminal status). A bare
    // fire-and-forget here used to leak orphans: the function returned
    // in <1s, Vercel reaped the instance, and the orchestrator's
    // already-claimed 'running' row was left stuck — the reviewer-side
    // poll never re-kicks while it sees 'running', so the stale-reclaim
    // in claimTakeAlignment never fired either. `after` is the
    // Next.js 16 wrapper around Vercel's `waitUntil` and inherits this
    // route's maxDuration.
    after(async () => {
      try {
        await runAlignmentForAssignment(assignment.id);
      } catch (e) {
        logger.error('alignment trigger failed', {
          assignmentId: assignment.id,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('PATCH full audio error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update full audio' }, { status: 500 });
  }
}

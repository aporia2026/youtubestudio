import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { getAssignment, updateSection, updateAssignment } from '@/lib/narrator-db';
import { notifyAssignmentApproved } from '@/lib/notify';

export const runtime = 'nodejs';

/**
 * Owner approves a narrator's full-narration upload.
 *
 * Mirrors the stitch flow for per-section narrations:
 *   1. Marks the synthetic section_number=0 row 'approved' with the
 *      full-audio take pinned as the approved take.
 *   2. Flips the assignment status to 'completed' — there's nothing left
 *      to stitch when the narrator delivered a single file.
 *   3. Inserts a 'voiceover' media_asset on the project so downstream
 *      surfaces (Voiceover tab, render pipeline) see the approved audio
 *      without a manual export step.
 *   4. Fires `notifyAssignmentApproved` so the narrator sees a bell entry
 *      + email — same channels we already use for retake / take-comment
 *      events on this assignment.
 *
 * Safe to call repeatedly — re-approving simply no-ops the duplicate
 * media_asset (the project_id + assignment_id pair de-dupes via metadata).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const assignment = await getAssignment(id) as {
      id: string;
      project_id: string;
      narrator_id: string | null;
      narrator_name: string | null;
      share_token: string;
      full_audio_take_id: string | null;
      full_audio_url: string | null;
      full_audio_r2_key: string | null;
      full_audio_duration_seconds: number | null;
      [k: string]: unknown;
    } | null;
    if (!assignment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!assignment.full_audio_take_id || !assignment.full_audio_url) {
      return NextResponse.json({ error: 'No full-narration upload to approve' }, { status: 400 });
    }

    // Locate the synthetic section_number=0 row that holds the full-audio take.
    const { rows: sectionRows } = await sql`
      SELECT id FROM narrator_sections
      WHERE assignment_id = ${id} AND section_number = 0
      LIMIT 1
    `;
    const sectionId = sectionRows[0]?.id as string | undefined;
    if (!sectionId) {
      return NextResponse.json({ error: 'Full-audio section missing' }, { status: 500 });
    }

    await updateSection(sectionId, {
      status: 'approved',
      approved_take_id: assignment.full_audio_take_id,
    });
    await updateAssignment(id, { status: 'completed' });

    // Mirror stitch flow: publish the approved audio as a project voiceover
    // so the Voiceover tab + render pipeline see it without a manual step.
    // De-dupe by metadata.assignment_id so re-approving doesn't multiply rows.
    // r2_bucket / r2_key are NOT included in the column list — those are
    // editor-side additions (added in ensureEditorSchema) that may not exist
    // on every DB; the values still travel through metadata for traceability.
    // Wrapped in try/catch so a media_asset hiccup doesn't block the
    // user-facing approve+notify flow — that's the core promise.
    const projectTitle = await sql`SELECT title FROM projects WHERE id = ${assignment.project_id} LIMIT 1`
      .then(r => (r.rows[0]?.title as string | undefined) || 'Untitled');
    const assetName = `Narration — ${assignment.narrator_name || 'Narrator'}`;
    try {
      await sql`
        INSERT INTO media_assets (project_id, type, source, name, url, blob_pathname, size_bytes, duration_seconds, metadata)
        SELECT
          ${assignment.project_id}, 'voiceover', 'upload', ${assetName},
          ${assignment.full_audio_url}, NULL, NULL,
          ${assignment.full_audio_duration_seconds},
          ${JSON.stringify({
            narrator_id: assignment.narrator_id,
            assignment_id: id,
            take_id: assignment.full_audio_take_id,
            r2_key: assignment.full_audio_r2_key,
            full_narration: true,
          })}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM media_assets
          WHERE project_id = ${assignment.project_id}
            AND type = 'voiceover'
            AND metadata->>'assignment_id' = ${id}
            AND metadata->>'full_narration' = 'true'
        )
      `;
    } catch (mediaErr) {
      console.error('approve-full: media_asset insert skipped:', mediaErr);
    }

    // Fire-and-forget — don't block the response on email I/O.
    if (assignment.narrator_id) {
      notifyAssignmentApproved({
        narratorId: assignment.narrator_id,
        shareToken: assignment.share_token,
        projectId: assignment.project_id,
        projectTitle,
        ownerName: 'Owner',
      }).catch(e => console.error('notifyAssignmentApproved failed:', e));
    }

    return NextResponse.json({ ok: true, status: 'completed' });
  } catch (err) {
    console.error('POST approve-full error:', err);
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to approve full narration: ${detail}` }, { status: 500 });
  }
}

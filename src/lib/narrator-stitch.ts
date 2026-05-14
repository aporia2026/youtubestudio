/**
 * Stitch the approved/selected takes for a narrator assignment into a
 * single voiceover MP3, upload it to Vercel Blob, and publish it as a
 * project `media_assets` row.
 *
 * Shared by the manual stitch endpoint
 * (`POST /api/narrator/assignments/[id]/stitch`) and the auto-stitch
 * hook fired from the section approval PUT route when the owner's last
 * per-section approval completes the assignment. Both paths produce the
 * same project artifact so the Voiceover panel and the workspace-wide
 * voiceover library stay in sync with the narrator-task status.
 *
 * No idempotency guard inside the helper — the caller is responsible for
 * checking whether an existing voiceover media_asset already covers this
 * assignment. The manual endpoint deliberately re-stitches on every
 * click (owner-initiated); the auto-stitch hook checks before invoking
 * so repeat approvals don't multiply rows.
 */
import { sql } from '@vercel/postgres';
import { getAssignment, getRealSectionsForAssignment } from './narrator-db';
import {
  buildStitchedNarrationKey,
  getDownloadUrlForBucket,
  getNarrationBucket,
  getNarrationDownloadUrl,
  uploadToBucket,
} from './r2';

export type StitchResult =
  | { ok: true; url: string; size: number; sections: number }
  | { ok: false; status: 400 | 404; reason: string };

type StitchTake = { id: string; audio_url: string; r2_key?: string | null; is_selected: boolean };

export async function stitchAssignmentVoiceover(assignmentId: string): Promise<StitchResult> {
  const assignment = await getAssignment(assignmentId);
  if (!assignment) return { ok: false, status: 404, reason: 'Not found' };

  // Real sections only — section_number = 0 is the synthetic holder for
  // the full-file upload path and would double the stitched output.
  const sections = await getRealSectionsForAssignment(assignmentId);

  // Pick one take per section: explicit approval > narrator-selected >
  // latest. Regenerate the R2 presigned URL from r2_key so we don't
  // depend on a possibly-expired audio_url cached at upload time.
  const audioUrls: string[] = [];
  for (const section of sections) {
    const takes = (section.takes || []) as StitchTake[];
    let take: StitchTake | null = null;
    if (section.approved_take_id) {
      take = takes.find((t) => t.id === section.approved_take_id) || null;
    }
    if (!take) take = takes.find((t) => t.is_selected) || null;
    if (!take && takes.length > 0) take = takes[0]; // Latest (sorted desc).
    if (!take) continue;
    if (take.r2_key) {
      try {
        audioUrls.push(await getNarrationDownloadUrl(take.r2_key));
      } catch {
        if (take.audio_url) audioUrls.push(take.audio_url);
      }
    } else if (take.audio_url) {
      audioUrls.push(take.audio_url);
    }
  }

  if (audioUrls.length === 0) {
    return { ok: false, status: 400, reason: 'No takes to stitch' };
  }

  // Audio hosts allowlist — Vercel Blob (legacy takes) + Cloudflare R2
  // (current narration bucket). An optional R2_NARRATION_PUBLIC_URL adds
  // the customer-managed public hostname.
  const ALLOWED_HOST_SUFFIXES = ['blob.vercel-storage.com', 'r2.cloudflarestorage.com', 'r2.dev'];
  const customR2Public = process.env.R2_NARRATION_PUBLIC_URL;
  if (customR2Public) {
    try { ALLOWED_HOST_SUFFIXES.push(new URL(customR2Public).hostname); } catch {}
  }

  const audioBuffers: ArrayBuffer[] = [];
  for (const url of audioUrls) {
    let parsedHost: string;
    try {
      parsedHost = new URL(url).hostname;
    } catch {
      return { ok: false, status: 400, reason: 'Invalid audio URL' };
    }
    if (!ALLOWED_HOST_SUFFIXES.some((h) => parsedHost.endsWith(h))) {
      return { ok: false, status: 400, reason: `Invalid audio source: ${parsedHost}` };
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch audio');
    audioBuffers.push(await res.arrayBuffer());
  }

  // MP3 is frame-based — binary concat works without re-encoding.
  const totalSize = audioBuffers.reduce((acc, buf) => acc + buf.byteLength, 0);
  const stitched = new Uint8Array(totalSize);
  let offset = 0;
  for (const buf of audioBuffers) {
    stitched.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  // Upload to R2 narration bucket. Same migration pattern as the rest
  // of the audio paths — consistent storage, no dependency on Blob.
  const bucket = getNarrationBucket();
  const r2Key = buildStitchedNarrationKey(assignmentId);
  await uploadToBucket(bucket, r2Key, Buffer.from(stitched), 'audio/mpeg');
  const audioUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_NARRATION_PUBLIC_URL);

  // workspace_id is NOT NULL on media_assets since migration 0013 —
  // copy it from the parent project to satisfy the constraint.
  // `r2_bucket` + `r2_key` are populated so the audio proxy streams
  // through R2 instead of redirecting to a defunct Blob URL.
  await sql`
    INSERT INTO media_assets (
      project_id, type, source, name, url,
      r2_bucket, r2_key, size_bytes, metadata, workspace_id
    )
    SELECT ${assignment.project_id}::uuid, 'voiceover', 'upload',
           ${`Narration — ${assignment.narrator_name}`},
           ${audioUrl},
           ${bucket}, ${r2Key}, ${totalSize},
           ${JSON.stringify({ narrator_id: assignment.narrator_id, assignment_id: assignmentId, stitched: true, sections: audioUrls.length })}::jsonb,
           p.workspace_id
      FROM projects p WHERE p.id = ${assignment.project_id}::uuid
  `;

  await sql`UPDATE narrator_assignments SET status = 'completed', updated_at = NOW() WHERE id = ${assignmentId}`;

  return { ok: true, url: audioUrl, size: totalSize, sections: audioUrls.length };
}

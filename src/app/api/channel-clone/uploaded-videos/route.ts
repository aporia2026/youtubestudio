/**
 * GET /api/channel-clone/uploaded-videos
 *
 * Workspace-scoped library of every reference video the operator has
 * uploaded in any past channel-clone run. Backed by the
 * `channel_clone_uploaded_videos` table (mig 0125), populated by the
 * intake-upload runner at end-of-intake.
 *
 * Rewritten 2026-06-08 — the original implementation walked
 * `channel_clone_jobs.state_jsonb.intake.sampleVideos` and HEAD-probed
 * R2 to filter expired keys. That coupling meant deleting a job (or
 * its R2 prefix) also destroyed every video the operator had ever
 * uploaded — the user pushed back hard ("It needs to save the uploaded
 * videos and transcripts regardless! These are all videos that are in
 * our storage!"). The library table decouples reusability from job
 * lifecycle. DELETE on a job no longer touches R2 or this table.
 *
 * DELETE /api/channel-clone/uploaded-videos
 *   Body: { r2Key: string }
 *   Removes one library entry (DB row + R2 staging object) so the
 *   operator can clean up videos they don't want in the picker
 *   anymore.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import {
  deleteUploadedVideo,
  listUploadedVideos,
} from '@/lib/channel-clone/uploaded-videos-store';
import { deleteFromBucket, getReviewBucket } from '@/lib/r2';

/** Disable route handler caching — the library is per-workspace and
 *  changes whenever an intake completes. */
export const dynamic = 'force-dynamic';

interface UploadedVideoEntry {
  r2Key: string;
  title: string;
  transcript: string;
  transcriptWordCount: number;
  durationSec: number;
  sourceJobId: string | null;
  sourceJobName: string | null;
  sourceJobCreatedAt: string;
  /** Always 0 in the new design — the index field is kept for client
   *  compatibility but the library decoupled itself from per-job
   *  ordering. */
  sourceVideoIndex: number;
}

export const GET = apiRoute.authed(async (session) => {
  const rows = await listUploadedVideos(session.ws, 500);
  logger.info('[channel-clone uploaded-videos GET] fetched', {
    workspaceId: session.ws,
    libraryCount: rows.length,
  });
  const videos: UploadedVideoEntry[] = rows.map((r) => ({
    r2Key: r.r2_key,
    title: r.title,
    transcript: r.transcript,
    transcriptWordCount: r.transcript_word_count,
    durationSec: r.duration_sec,
    sourceJobId: r.source_job_id,
    sourceJobName: r.source_job_name,
    sourceJobCreatedAt: r.created_at,
    sourceVideoIndex: 0,
  }));
  return NextResponse.json({
    videos,
    // Kept for the picker's stats line. The new design doesn't scan
    // job rows — every library row IS reusable by definition (we
    // wrote it after the bytes successfully landed in staging).
    totalRunsScanned: videos.length,
    reusableCount: videos.length,
    expiredCount: 0,
  });
});

/** Permanently remove one library entry. Body: { r2Key }. */
export const DELETE = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const r2Key = typeof b.r2Key === 'string' ? b.r2Key.trim() : '';
  if (!r2Key) {
    return NextResponse.json({ error: 'r2Key is required' }, { status: 400 });
  }
  // Workspace-prefix guard: the staging key must live under this
  // workspace's prefix. Even though the DB delete is workspace-scoped
  // already, this catches a malformed body before we issue the R2
  // delete (which has no per-key tenant scoping).
  const expectedPrefix = `channel-clone-uploads-staging/${session.ws}/`;
  if (!r2Key.startsWith(expectedPrefix)) {
    return NextResponse.json(
      { error: 'r2Key belongs to another workspace' },
      { status: 403 },
    );
  }
  const ok = await deleteUploadedVideo(session.ws, r2Key);
  if (!ok) {
    return NextResponse.json({ error: 'library entry not found' }, { status: 404 });
  }
  // Fire-and-forget the R2 delete. If R2 fails the DB row is already
  // gone and the picker stops showing the entry; the orphan R2 object
  // is cheap and can be reaped by a sweep cron.
  void deleteFromBucket(getReviewBucket(), r2Key).catch((err) => {
    logger.warn('[channel-clone uploaded-videos DELETE] R2 delete failed', {
      r2Key, error: err instanceof Error ? err.message : String(err),
    });
  });
  logger.info('[channel-clone uploaded-videos DELETE] removed', {
    workspaceId: session.ws, r2Key,
  });
  return NextResponse.json({ ok: true });
});

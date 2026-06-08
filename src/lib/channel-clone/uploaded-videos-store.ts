/**
 * Workspace-scoped library of reusable reference videos uploaded into
 * channel-clone runs. Backed by `channel_clone_uploaded_videos` (mig
 * 0125). Outlives the job that originally uploaded the video — the
 * "Pick from previous uploads" picker reads from here so deleting an
 * old run no longer destroys its videos for future reuse.
 *
 * Coupling intentionally weak:
 *   - source_job_id is informational only (no FK constraint), so the
 *     row stays valid when the originating job is deleted.
 *   - Upsert on (workspace_id, r2_key) — re-running an upload that
 *     produces the same staging key (e.g. a Reuse-from-job flow that
 *     re-stages the same bytes) refreshes the row in place rather
 *     than creating a duplicate.
 *
 * Cleanup contract: this module never touches R2. The DELETE endpoint
 * for a library entry calls into the R2 helpers separately, and the
 * job-row DELETE no longer touches R2 at all (the library + R2 keys
 * are now permanent unless the operator explicitly evicts them).
 */

import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';

export interface UploadedVideoLibraryRow {
  id: string;
  workspace_id: string;
  r2_key: string;
  title: string;
  transcript: string;
  transcript_word_count: number;
  duration_sec: number;
  source_job_id: string | null;
  source_job_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertUploadedVideoInput {
  workspaceId: string;
  r2Key: string;
  title: string;
  transcript: string;
  transcriptWordCount: number;
  durationSec: number;
  sourceJobId: string;
  sourceJobName: string | null;
}

/** Insert or refresh one library row. Idempotent on (workspace_id,
 *  r2_key). Returns true if a row was written (insert or update),
 *  false on a no-op (none of the columns differ from the existing
 *  row's values). */
export async function upsertUploadedVideo(input: UpsertUploadedVideoInput): Promise<boolean> {
  const { rowCount } = await sql.query(
    `
    INSERT INTO channel_clone_uploaded_videos (
      workspace_id, r2_key, title, transcript,
      transcript_word_count, duration_sec,
      source_job_id, source_job_name
    )
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8)
    ON CONFLICT (workspace_id, r2_key)
    DO UPDATE SET
      title = EXCLUDED.title,
      transcript = EXCLUDED.transcript,
      transcript_word_count = EXCLUDED.transcript_word_count,
      duration_sec = EXCLUDED.duration_sec,
      source_job_id = EXCLUDED.source_job_id,
      source_job_name = EXCLUDED.source_job_name,
      updated_at = now()
    `,
    [
      input.workspaceId,
      input.r2Key,
      input.title,
      input.transcript,
      input.transcriptWordCount,
      input.durationSec,
      input.sourceJobId,
      input.sourceJobName,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** List the workspace's library, most-recent-first. */
export async function listUploadedVideos(
  workspaceId: string,
  limit = 500,
): Promise<UploadedVideoLibraryRow[]> {
  const { rows } = await sql.query<UploadedVideoLibraryRow>(
    `
    SELECT id::text, workspace_id::text, r2_key, title, transcript,
           transcript_word_count, duration_sec,
           source_job_id::text, source_job_name,
           created_at::text, updated_at::text
      FROM channel_clone_uploaded_videos
     WHERE workspace_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2::int
    `,
    [workspaceId, limit],
  );
  return rows;
}

/** Delete one library entry by r2_key. Workspace-scoped guard: a
 *  caller from another workspace can't reach across. Returns true
 *  on hit. */
export async function deleteUploadedVideo(
  workspaceId: string,
  r2Key: string,
): Promise<boolean> {
  const { rowCount } = await sql.query(
    `
    DELETE FROM channel_clone_uploaded_videos
     WHERE workspace_id = $1::uuid AND r2_key = $2
    `,
    [workspaceId, r2Key],
  );
  return (rowCount ?? 0) > 0;
}

/** Best-effort log-and-swallow wrapper around upsertUploadedVideo
 *  for use inside the intake-upload runner, where library-row
 *  persistence must NEVER fail an intake. Returns nothing — failures
 *  are logged at warn level and absorbed. */
export async function tryPersistUploadedVideo(
  input: UpsertUploadedVideoInput,
): Promise<void> {
  try {
    await upsertUploadedVideo(input);
  } catch (err) {
    logger.warn('[channel-clone uploaded-videos-store] upsert failed', {
      r2Key: input.r2Key,
      workspaceId: input.workspaceId,
      sourceJobId: input.sourceJobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

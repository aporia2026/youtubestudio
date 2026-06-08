/**
 * YouTube uploader for shorts in a batch (and one-off single-short
 * uploads — same code path).
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Each upload:
 *   1. Verify the short is uploadable (rendered + not already
 *      uploaded + workspace-scoped).
 *   2. Resolve the channel's OAuth token via `getValidAccessToken`.
 *   3. Record the quota charge BEFORE the API call (conservative —
 *      matches YouTube's behavior of charging for failed inserts).
 *   4. Download the rendered video bytes (currently a public R2 URL,
 *      so a plain fetch is enough — no signed URL ceremony).
 *   5. Call `youtube-upload.ts` with the merged metadata + publishAt.
 *   6. Attach to selected playlists.
 *   7. Persist youtube_video_id + youtube_status + youtube_uploaded_at
 *      on the short.
 *
 * Failure semantics:
 *   - Validation errors (missing token, no render, bad metadata)
 *     short-circuit before the API call; nothing is persisted.
 *   - API errors set `youtube_upload_error` on the short so the
 *     review queue can surface them. The short remains re-uploadable
 *     (youtube_video_id stays null on failure).
 *   - Playlist attachment failures DO NOT roll back the upload —
 *     the video is on YouTube; the failed playlist attachments are
 *     reported back so the UI can show "uploaded but couldn't attach
 *     to playlist X" with a retry button.
 */
import { sql } from '@vercel/postgres';
import { getValidAccessToken } from './google-oauth';
import { uploadVideo, VIDEOS_INSERT_QUOTA_UNITS } from './youtube-upload';
import { addVideoToPlaylists, type PlaylistAttachmentResult } from './youtube-playlists';
import { recordUploadCharge } from './youtube-quota';
import { getBatchWithShorts } from './shorts-batches';
import type { ShortRow } from './shorts-types';
import type {
  ShortYoutubeStatus,
  YoutubeUploadMetadata,
  YoutubeUploadResult,
} from './shorts-batches-types';

/** Result for a single short upload — same shape whether the caller
 *  invoked the one-off path or the drain-all path. */
export interface SingleShortUploadOutcome {
  shortId: string;
  ok: boolean;
  videoId: string | null;
  status: ShortYoutubeStatus | null;
  playlistResults: PlaylistAttachmentResult[];
  error: string | null;
}

/** Result for the drain-all path — one outcome per short the
 *  uploader picked up. */
export interface BatchUploadOutcome {
  batchId: string;
  processed: SingleShortUploadOutcome[];
  /** Shorts that were in the batch but skipped (e.g. not yet
   *  rendered, already uploaded). The UI can show "X skipped:
   *  awaiting render" if the count is non-zero. */
  skipped: Array<{ shortId: string; reason: string }>;
}

/** Pure: tell the caller why a short can't be uploaded right now, or
 *  null if it's eligible. Exposed so the upload-all path can show a
 *  clear reason for each skipped short. */
export function reasonShortIsNotUploadable(short: ShortRow): string | null {
  if (!short.rendered_video_url) return 'awaiting render';
  if (short.youtube_video_id) return 'already uploaded';
  if (short.youtube_status === 'uploading') return 'upload in flight';
  return null;
}

/** Download the rendered video as a Buffer. Plain fetch — the
 *  rendered_video_url is a public R2 URL today. If the project moves
 *  to signed URLs, this is the seam to swap. */
async function downloadRenderedVideo(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch rendered video (${res.status}) from ${url}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

/** Mark a short as "uploading" before the API call — gives the UI a
 *  loading state and prevents a parallel re-upload from another tab. */
async function markUploadStarting(shortId: string): Promise<void> {
  await sql`
    UPDATE shorts
       SET youtube_status = 'uploading',
           youtube_upload_error = NULL,
           updated_at = NOW()
     WHERE id = ${shortId}::uuid
  `;
}

/** Persist the result of a successful upload. */
async function recordUploadSuccess(args: {
  shortId: string;
  videoId: string;
  status: ShortYoutubeStatus;
}): Promise<void> {
  const { shortId, videoId, status } = args;
  await sql`
    UPDATE shorts
       SET youtube_video_id = ${videoId},
           youtube_status = ${status},
           youtube_uploaded_at = NOW(),
           youtube_upload_error = NULL,
           updated_at = NOW()
     WHERE id = ${shortId}::uuid
  `;
}

/** Persist the failure so the review queue can show it + the user can
 *  retry. Resets `youtube_status` so the UI doesn't strand the short
 *  in 'uploading' forever. */
async function recordUploadFailure(shortId: string, error: string): Promise<void> {
  await sql`
    UPDATE shorts
       SET youtube_status = 'failed',
           youtube_upload_error = ${error.slice(0, 500)},
           updated_at = NOW()
     WHERE id = ${shortId}::uuid
  `;
}

/** Fetch the short + scope-check workspace. Returns null if missing
 *  / cross-workspace so the route can map to 404 without leaking
 *  another tenant's row. */
async function getShortForUpload(shortId: string, workspaceId: string): Promise<ShortRow | null> {
  const { rows } = await sql<ShortRow>`
    SELECT
      id, workspace_id, project_id, source_script_id, kind, medium,
      title, short_script, hook, payoff,
      word_count, estimated_duration_seconds,
      source_title, source_description, seo_result,
      voiceover_audio_url, voiceover_blob_pathname,
      voiceover_voice_id, voiceover_duration_seconds,
      rendered_video_url, ai_model, generation_params, notes,
      hook_score, dismissed_at::text AS dismissed_at,
      source_youtube_video_id, clip_start_ms, clip_end_ms,
      style_id, style_assets, captions_config, generation_progress,
      assets_context,
      qa_result, qa_score, qa_run_at::text AS qa_run_at,
      batch_id,
      youtube_video_id, youtube_status,
      youtube_publish_at::text AS youtube_publish_at,
      youtube_metadata,
      youtube_uploaded_at::text AS youtube_uploaded_at,
      youtube_upload_error,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM shorts
    WHERE id = ${shortId}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Upload a single short. Used by the one-off "Upload" button on a
 * card AND by the batch drain (which loops this function).
 */
export async function uploadSingleShort(args: {
  shortId: string;
  workspaceId: string;
  channelId: string;
}): Promise<SingleShortUploadOutcome> {
  const { shortId, workspaceId, channelId } = args;

  const short = await getShortForUpload(shortId, workspaceId);
  if (!short) {
    return {
      shortId,
      ok: false,
      videoId: null,
      status: null,
      playlistResults: [],
      error: 'Short not found in this workspace.',
    };
  }

  const skipReason = reasonShortIsNotUploadable(short);
  if (skipReason) {
    return {
      shortId,
      ok: false,
      videoId: null,
      status: short.youtube_status,
      playlistResults: [],
      error: `Not uploadable: ${skipReason}.`,
    };
  }

  const accessToken = await getValidAccessToken(channelId);
  if (!accessToken) {
    const msg = 'Channel is not OAuth-connected (or token refresh failed). Reconnect the channel and retry.';
    await recordUploadFailure(shortId, msg);
    return { shortId, ok: false, videoId: null, status: 'failed', playlistResults: [], error: msg };
  }

  await markUploadStarting(shortId);
  // Charge quota BEFORE the call — matches YouTube's billing for
  // failed inserts and means a function crash mid-upload still leaves
  // the counter correct.
  await recordUploadCharge({ channelId, units: VIDEOS_INSERT_QUOTA_UNITS });

  let uploadResult: YoutubeUploadResult;
  try {
    const videoBytes = await downloadRenderedVideo(short.rendered_video_url!);
    uploadResult = await uploadVideo({
      accessToken,
      metadata: short.youtube_metadata as YoutubeUploadMetadata,
      videoBytes,
      publishAtUtc: short.youtube_publish_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordUploadFailure(shortId, message);
    return { shortId, ok: false, videoId: null, status: 'failed', playlistResults: [], error: message };
  }

  await recordUploadSuccess({ shortId, videoId: uploadResult.videoId, status: uploadResult.status });

  let playlistResults: PlaylistAttachmentResult[] = [];
  const playlistIds = (short.youtube_metadata as YoutubeUploadMetadata).playlistIds ?? [];
  if (playlistIds.length > 0) {
    playlistResults = await addVideoToPlaylists({
      accessToken,
      videoId: uploadResult.videoId,
      playlistIds,
    });
  }

  return {
    shortId,
    ok: true,
    videoId: uploadResult.videoId,
    status: uploadResult.status,
    playlistResults,
    error: null,
  };
}

/**
 * Drain the upload-ready shorts in a batch. Sequential (not
 * parallel) — YouTube doesn't love concurrent uploads from the same
 * channel and the quota / rate-limit cost of bursting is higher than
 * any wall-clock gain at batch sizes of 5-10.
 *
 * Pre-flight: requires a channel_id on the batch. The caller is
 * responsible for transitioning the batch into 'uploading' before
 * calling this and out of 'uploading' afterwards.
 */
export async function uploadBatchReadyShorts(args: {
  batchId: string;
  workspaceId: string;
}): Promise<BatchUploadOutcome> {
  const { batchId, workspaceId } = args;

  const bundle = await getBatchWithShorts(batchId, workspaceId);
  if (!bundle) {
    return { batchId, processed: [], skipped: [] };
  }
  const { batch, shorts } = bundle;

  if (!batch.channel_id) {
    return {
      batchId,
      processed: [],
      skipped: shorts.map((s) => ({ shortId: s.id, reason: 'batch has no channel_id' })),
    };
  }

  const processed: SingleShortUploadOutcome[] = [];
  const skipped: Array<{ shortId: string; reason: string }> = [];

  for (const short of shorts) {
    const reason = reasonShortIsNotUploadable(short);
    if (reason) {
      skipped.push({ shortId: short.id, reason });
      continue;
    }
    const outcome = await uploadSingleShort({
      shortId: short.id,
      workspaceId,
      channelId: batch.channel_id,
    });
    processed.push(outcome);
  }

  return { batchId, processed, skipped };
}

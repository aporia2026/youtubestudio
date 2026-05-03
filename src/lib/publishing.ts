/**
 * YouTube publishing orchestrator. Closes the production loop —
 * uploads a finished MP4 to YouTube, sets thumbnail + playlist, and
 * tracks the lifecycle in `published_videos`.
 *
 * Pipeline (per publish):
 *   1. INSERT row with status = 'queued'
 *   2. Validate input (markFailed + return on validation error)
 *   3. Status = 'uploading' — fetch source MP4 buffer
 *   4. POST to YouTube videos.insert (multipart/related)
 *   5. Persist youtube_video_id + youtube_url, status = 'processing'
 *   6. (Optional, best-effort) thumbnails.set
 *   7. (Optional, best-effort) playlistItems.insert
 *   8. Return { id, status, youtubeVideoId? }
 *
 * Step 6/7 failures don't fail the publish — the row is `processing`
 * and the user gets a partial-success signal in `error_message`.
 *
 * The row stays in `processing` until `pollPublishStatus` is called
 * (by the status route on demand or a polling cron) and YouTube
 * reports `processingStatus = succeeded`.
 *
 * Channel OAuth tokens are loaded via `getValidAccessToken` from
 * `google-oauth.ts` — same path A/B-test variant push uses.
 */

import { sql } from '@vercel/postgres';
import { getValidAccessToken } from './google-oauth';
import { uploadThumbnailOAuth } from './youtube';
import { logger } from './logger';
import { resolveAndPinSafeUrl } from './url-safety';
import {
  validatePublishRequest,
  buildVideosInsertSnippet,
  buildVideosInsertStatus,
  buildYoutubeUrl,
  nextStatusFor,
  type PublishRequest,
  type PublishedVideoRow,
  type PublishStatus,
} from './publishing-types';

export type {
  PublishStatus,
  PublishRequest,
  PublishedVideoRow,
} from './publishing-types';

const YOUTUBE_RESUMABLE_INIT_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable';
const YOUTUBE_PLAYLIST_INSERT_URL =
  'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet';
const YOUTUBE_VIDEOS_LIST_URL = 'https://www.googleapis.com/youtube/v3/videos';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function insertQueuedRow(req: PublishRequest): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO published_videos (
      workspace_id, channel_db_id, project_id, schedule_item_id,
      source_video_url,
      title, description, tags, category_id, default_language,
      privacy_status, publish_at, made_for_kids,
      thumbnail_url, playlist_id,
      initiated_by, idempotency_key,
      status
    ) VALUES (
      ${req.workspaceId}::uuid,
      ${req.channelDbId}::uuid,
      ${req.projectId ?? null}::uuid,
      ${req.scheduleItemId ?? null}::uuid,
      ${req.sourceVideoUrl},
      ${req.title.trim()},
      ${req.description ?? ''},
      ${JSON.stringify((req.tags ?? []).map((t) => t.trim()).filter(Boolean))}::jsonb,
      ${req.categoryId ?? '22'},
      ${req.defaultLanguage ?? null},
      ${req.privacyStatus ?? 'private'},
      ${req.publishAt ?? null},
      ${req.madeForKids ?? false},
      ${req.thumbnailUrl ?? null},
      ${req.playlistId ?? null},
      ${req.initiatedBy ?? null}::uuid,
      ${req.idempotencyKey ?? null},
      'queued'
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Look up an existing publish row by (workspaceId, idempotencyKey).
 *  Used by the orchestrator to short-circuit a retry — see audit C7. */
async function findByIdempotencyKey(
  workspaceId: string,
  key: string,
): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM published_videos
     WHERE workspace_id = ${workspaceId}::uuid
       AND idempotency_key = ${key}
     LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Compare-and-swap status updates. Each helper guards on the
 * source state(s) so a late-arriving error / signal can never
 * overwrite a row that has already advanced to a terminal state
 * ('live'). Audit C5 + M12.
 *
 * On a refused transition, we log at warn level (so we can spot
 * orchestrator bugs in the wild) but don't throw — the orchestrator's
 * own control flow already moved past that step.
 */
async function markFailed(id: string, msg: string): Promise<void> {
  // Refuse to overwrite a 'live' row: a publish that completed
  // can't be retroactively marked failed by a stale error path.
  const r = await sql`
    UPDATE published_videos
       SET status = 'failed',
           error_message = ${msg},
           updated_at = NOW()
     WHERE id = ${id}::uuid
       AND status != 'live'
  `;
  if ((r.rowCount ?? 0) === 0) {
    logger.warn('publish: markFailed refused (row already live or missing)', { id });
  }
}

async function markUploading(id: string): Promise<void> {
  // Only valid from 'queued' — anything else means the orchestrator
  // already advanced and a duplicate call is racing.
  const r = await sql`
    UPDATE published_videos
       SET status = 'uploading',
           updated_at = NOW()
     WHERE id = ${id}::uuid
       AND status = 'queued'
  `;
  if ((r.rowCount ?? 0) === 0) {
    logger.warn('publish: markUploading refused (row not in queued)', { id });
  }
}

async function markProcessing(id: string, ytVideoId: string): Promise<void> {
  // Only valid from 'uploading'.
  const r = await sql`
    UPDATE published_videos
       SET status = 'processing',
           youtube_video_id = ${ytVideoId},
           youtube_url = ${buildYoutubeUrl(ytVideoId)},
           uploaded_at = NOW(),
           updated_at = NOW()
     WHERE id = ${id}::uuid
       AND status = 'uploading'
  `;
  if ((r.rowCount ?? 0) === 0) {
    logger.warn('publish: markProcessing refused (row not in uploading)', { id });
  }
}

async function appendErrorNote(id: string, note: string): Promise<void> {
  // Used for partial-success signals (thumbnail / playlist failure)
  // that don't fail the whole publish. Appended to error_message
  // alongside the existing value.
  await sql`
    UPDATE published_videos
       SET error_message = COALESCE(error_message || ' | ', '') || ${note},
           updated_at = NOW()
     WHERE id = ${id}::uuid
  `;
}

// ---------------------------------------------------------------------------
// YouTube wire
// ---------------------------------------------------------------------------

interface VideosInsertResponse {
  id?: string;
  snippet?: { title?: string };
  status?: { uploadStatus?: string; processingStatus?: string };
  error?: { code: number; message: string };
}

/** Open a streaming response for the source MP4. Returns the raw
 *  body stream + the metadata YouTube needs (size + MIME) to set up
 *  the resumable upload session. The body is consumed by piping
 *  directly into the YouTube PUT — never materialised in memory.
 *  Audit M10. */
async function openSourceVideo(url: string): Promise<{
  body: ReadableStream<Uint8Array>;
  size: number;
  mimeType: string;
}> {
  // Audit C4 + Phase 8.6.1: previously this called fetch(url) with
  // a string-only SSRF check, which left a DNS-rebinding window
  // (hostname resolves public on validation, private on fetch).
  // resolveAndPinSafeUrl resolves once via dns.lookup, validates every
  // returned address, and returns a Dispatcher pinned to that set so
  // undici can't be re-resolved into AWS IMDS / 127.0.0.1 / RFC1918.
  // See src/lib/url-safety.ts for the helper + the rebinding rationale.
  const { url: safe, dispatcher } = await resolveAndPinSafeUrl(url, {
    allowedProtocols: ['https:'],
  });
  const res = await fetch(safe, { dispatcher } as RequestInit & { dispatcher: unknown });
  if (!res.ok) throw new Error(`Failed to fetch source video: ${res.status} ${res.statusText}`);
  const lenHeader = res.headers.get('content-length');
  const size = lenHeader ? Number.parseInt(lenHeader, 10) : NaN;
  if (!Number.isFinite(size) || size <= 0) {
    // YouTube's resumable upload requires Content-Length up front.
    // Without it from the source, we'd have to buffer the whole body
    // anyway. Defer that to a future enhancement and surface the
    // limitation clearly.
    throw new Error(
      'Source video URL did not return a Content-Length header. ' +
      'YouTube resumable upload needs the byte size up front — host ' +
      'the file somewhere that returns Content-Length (Vercel Blob does).',
    );
  }
  return {
    body: res.body!,
    size,
    mimeType: res.headers.get('content-type') || 'video/mp4',
  };
}

/** Two-step resumable upload to YouTube videos.insert.
 *
 *  Step 1 (init): POST the JSON metadata to the resumable endpoint
 *  with X-Upload-Content-Length + X-Upload-Content-Type headers.
 *  YouTube responds 200 with a `Location:` header pointing at the
 *  per-upload session URL.
 *
 *  Step 2 (upload): PUT the video bytes to the session URL with
 *  Content-Length = total size. We pipe `body` straight in — no
 *  in-memory buffering — so a 2GB upload uses only the chunk-buffer
 *  RAM that Node's fetch maintains internally. */
async function callVideosInsert(
  accessToken: string,
  metadata: { snippet: object; status: object },
  videoBody: ReadableStream<Uint8Array>,
  videoSize: number,
  videoMime: string,
): Promise<VideosInsertResponse> {
  // Step 1: resumable session init.
  const metaBody = JSON.stringify(metadata);
  const initRes = await fetch(YOUTUBE_RESUMABLE_INIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': Buffer.byteLength(metaBody, 'utf8').toString(),
      'X-Upload-Content-Length': videoSize.toString(),
      'X-Upload-Content-Type': videoMime,
    },
    body: metaBody,
  });
  if (!initRes.ok) {
    const errJson = (await initRes.json().catch(() => ({}))) as VideosInsertResponse;
    const msg = errJson.error?.message || `videos.insert init returned ${initRes.status}`;
    throw new Error(msg);
  }
  const sessionUrl = initRes.headers.get('location') || initRes.headers.get('Location');
  if (!sessionUrl) {
    throw new Error('videos.insert init did not return a Location header for the upload session.');
  }

  // Step 2: stream the bytes into the PUT.
  // `duplex: 'half'` is required by Node's fetch when sending a
  // ReadableStream body — opts into the half-duplex protocol that
  // sends the request body before reading the response.
  const uploadRes = await fetch(sessionUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': videoMime,
      'Content-Length': videoSize.toString(),
    },
    body: videoBody,
    // @ts-expect-error — `duplex` is required for streaming bodies but
    // not yet in the Node fetch types we have.
    duplex: 'half',
  });
  const json = (await uploadRes.json().catch(() => ({}))) as VideosInsertResponse;
  if (!uploadRes.ok) {
    const msg = json.error?.message || `videos.insert upload returned ${uploadRes.status}`;
    throw new Error(msg);
  }
  if (!json.id) throw new Error('videos.insert succeeded without returning a video id');
  return json;
}

async function addToPlaylist(
  accessToken: string,
  playlistId: string,
  youtubeVideoId: string,
): Promise<void> {
  const res = await fetch(YOUTUBE_PLAYLIST_INSERT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      snippet: {
        playlistId,
        resourceId: {
          kind: 'youtube#video',
          videoId: youtubeVideoId,
        },
      },
    }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({ error: { message: 'unknown' } }))) as {
      error?: { message?: string };
    };
    throw new Error(json.error?.message || `playlistItems.insert returned ${res.status}`);
  }
}

async function fetchYoutubeStatus(
  accessToken: string,
  youtubeVideoId: string,
): Promise<{ uploadStatus: string | null; processingStatus: string | null; privacyStatus: string | null }> {
  const url = `${YOUTUBE_VIDEOS_LIST_URL}?part=status&id=${encodeURIComponent(youtubeVideoId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`videos.list returned ${res.status}`);
  const json = (await res.json()) as {
    items?: Array<{
      status?: { uploadStatus?: string; processingStatus?: string; privacyStatus?: string };
    }>;
  };
  const status = json.items?.[0]?.status;
  return {
    uploadStatus: status?.uploadStatus ?? null,
    processingStatus: status?.processingStatus ?? null,
    privacyStatus: status?.privacyStatus ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

export interface PublishResult {
  id: string;
  status: PublishStatus;
  youtubeVideoId: string | null;
  youtubeUrl: string | null;
  errorMessage: string | null;
}

/**
 * Run the full publish pipeline. Returns once `videos.insert` has
 * succeeded (status = 'processing') or failed (status = 'failed').
 * NEVER throws to the caller — the row's status + error_message are
 * the canonical signal.
 *
 * The row stays in 'processing' until `pollPublishStatus` is called.
 */
export async function publishVideoToYouTube(req: PublishRequest): Promise<PublishResult> {
  // -- 1. Validate before touching the DB so a bad request doesn't
  //       leave a half-baked row behind.
  const validation = validatePublishRequest(req);
  if (!validation.ok) {
    // Throw rather than insert+fail — the route maps this to a 400 so
    // the user fixes the input. A queued+failed row from validation
    // pollutes the timeline.
    throw new Error(validation.errors.join(' '));
  }

  // -- 1a. Idempotency short-circuit (audit C7). If the caller sent a
  //        key and we've seen it before in this workspace, return the
  //        existing row's status. The orchestrator does NOT re-do any
  //        work — the original call is the source of truth.
  if (req.idempotencyKey) {
    const existingId = await findByIdempotencyKey(req.workspaceId, req.idempotencyKey);
    if (existingId) {
      const row = await getPublishedVideo(existingId, req.workspaceId);
      if (row) {
        return {
          id: row.id,
          status: row.status,
          youtubeVideoId: row.youtube_video_id,
          youtubeUrl: row.youtube_url,
          errorMessage: row.error_message,
        };
      }
    }
  }

  const id = await insertQueuedRow(req);

  // -- 2. Resolve channel OAuth.
  const accessToken = await getValidAccessToken(req.channelDbId);
  if (!accessToken) {
    const msg = 'Channel is not OAuth-connected (or token refresh failed). Reconnect the channel and try again.';
    await markFailed(id, msg);
    return { id, status: 'failed', youtubeVideoId: null, youtubeUrl: null, errorMessage: msg };
  }

  // -- 3. Status: uploading. Open the source video as a stream — the
  //       body is piped straight into the YouTube PUT, never
  //       materialised in memory. Audit M10.
  await markUploading(id);
  let videoBody: ReadableStream<Uint8Array>;
  let videoSize: number;
  let videoMime: string;
  try {
    const opened = await openSourceVideo(req.sourceVideoUrl);
    videoBody = opened.body;
    videoSize = opened.size;
    videoMime = opened.mimeType;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('publish: source open failed', { id, detail: msg });
    await markFailed(id, `Source video fetch failed: ${msg}`);
    nextStatusFor('uploading', 'upload_failed');
    return { id, status: 'failed', youtubeVideoId: null, youtubeUrl: null, errorMessage: msg };
  }

  // -- 4. videos.insert via two-step resumable protocol.
  let response: VideosInsertResponse;
  try {
    response = await callVideosInsert(
      accessToken,
      {
        snippet: buildVideosInsertSnippet(req),
        status: buildVideosInsertStatus(req),
      },
      videoBody,
      videoSize,
      videoMime,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('publish: videos.insert failed', { id, detail: msg });
    await markFailed(id, `YouTube upload failed: ${msg}`);
    nextStatusFor('uploading', 'upload_failed');
    return { id, status: 'failed', youtubeVideoId: null, youtubeUrl: null, errorMessage: msg };
  }

  const ytVideoId = response.id!;
  await markProcessing(id, ytVideoId);
  nextStatusFor('uploading', 'upload_succeeded'); // assertion-only call to surface state-machine bugs

  // -- 5. Optional thumbnail (best-effort — partial success).
  if (req.thumbnailUrl) {
    try {
      // Same DNS-pin protection as the source video — see C4 + 8.6.1.
      const { url: safeThumb, dispatcher: thumbDispatcher } = await resolveAndPinSafeUrl(
        req.thumbnailUrl,
        { allowedProtocols: ['https:'] },
      );
      const thumbRes = await fetch(safeThumb, {
        dispatcher: thumbDispatcher,
      } as RequestInit & { dispatcher: unknown });
      if (!thumbRes.ok) throw new Error(`thumbnail fetch ${thumbRes.status}`);
      const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
      const thumbMime = thumbRes.headers.get('content-type') || 'image/jpeg';
      const r = await uploadThumbnailOAuth(accessToken, ytVideoId, thumbBuf, thumbMime);
      if (!r.success) throw new Error(r.error || 'unknown thumbnail error');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('publish: thumbnail upload failed (non-fatal)', { id, detail: msg });
      await appendErrorNote(id, `Thumbnail upload failed: ${msg}`);
    }
  }

  // -- 6. Optional playlist add (best-effort).
  if (req.playlistId) {
    try {
      await addToPlaylist(accessToken, req.playlistId, ytVideoId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('publish: playlist add failed (non-fatal)', { id, detail: msg });
      await appendErrorNote(id, `Playlist add failed: ${msg}`);
    }
  }

  return {
    id,
    status: 'processing',
    youtubeVideoId: ytVideoId,
    youtubeUrl: buildYoutubeUrl(ytVideoId),
    errorMessage: null,
  };
}

/** Poll YouTube for the row's processing status. Updates the row to
 *  'live' when YouTube reports the upload + processing both succeeded;
 *  to 'failed' when YouTube reports a processing failure. Returns the
 *  current status. Safe to call repeatedly; no-op when status is
 *  already terminal. */
export async function pollPublishStatus(
  id: string,
  workspaceId: string,
): Promise<{ status: PublishStatus; youtubeVideoId: string | null }> {
  const { rows } = await sql<{
    status: PublishStatus;
    youtube_video_id: string | null;
    channel_db_id: string;
  }>`
    SELECT status, youtube_video_id, channel_db_id
      FROM published_videos
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new Error('Published video not found in this workspace');
  if (row.status !== 'processing' || !row.youtube_video_id) {
    return { status: row.status, youtubeVideoId: row.youtube_video_id };
  }

  const accessToken = await getValidAccessToken(row.channel_db_id);
  if (!accessToken) {
    return { status: 'processing', youtubeVideoId: row.youtube_video_id };
  }

  let ytStatus: Awaited<ReturnType<typeof fetchYoutubeStatus>>;
  try {
    ytStatus = await fetchYoutubeStatus(accessToken, row.youtube_video_id);
  } catch (err) {
    logger.warn('publish: poll status failed', {
      id,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { status: 'processing', youtubeVideoId: row.youtube_video_id };
  }

  // YouTube's processingStatus values: processing, succeeded, failed,
  // terminated. Map to our state machine. Both flips are guarded on
  // the source state being 'processing' so a race between two cron
  // invocations or modal-poll + cron can't double-flip the row.
  if (ytStatus.processingStatus === 'succeeded' && ytStatus.uploadStatus === 'uploaded') {
    const r = await sql`
      UPDATE published_videos
         SET status = 'live',
             upload_status = ${ytStatus.uploadStatus},
             processing_status = ${ytStatus.processingStatus},
             privacy_status_actual = ${ytStatus.privacyStatus},
             live_at = NOW(),
             updated_at = NOW()
       WHERE id = ${id}::uuid
         AND status = 'processing'
    `;
    // Only emit the producer event if WE were the call that flipped
    // the row to live (rowCount > 0). Otherwise a concurrent caller
    // already emitted and we'd duplicate the webhook + workflow fire.
    if ((r.rowCount ?? 0) > 0) {
      void emitVideoPublishedEvent(id, workspaceId);
    }
    return { status: 'live', youtubeVideoId: row.youtube_video_id };
  }
  if (ytStatus.processingStatus === 'failed' || ytStatus.processingStatus === 'terminated') {
    await sql`
      UPDATE published_videos
         SET status = 'failed',
             upload_status = ${ytStatus.uploadStatus},
             processing_status = ${ytStatus.processingStatus},
             error_message = ${`YouTube reported processingStatus = ${ytStatus.processingStatus}`},
             updated_at = NOW()
       WHERE id = ${id}::uuid
         AND status = 'processing'
    `;
    return { status: 'failed', youtubeVideoId: row.youtube_video_id };
  }
  // Still processing — refresh the YouTube fields without flipping
  // status, so the UI sees the latest signal.
  await sql`
    UPDATE published_videos
       SET upload_status = ${ytStatus.uploadStatus},
           processing_status = ${ytStatus.processingStatus},
           privacy_status_actual = ${ytStatus.privacyStatus},
           updated_at = NOW()
     WHERE id = ${id}::uuid
  `;
  return { status: 'processing', youtubeVideoId: row.youtube_video_id };
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/** List recent publishes for a workspace, newest first. Optional
 *  filters use the "$N IS NULL OR col = $N" pattern so the same query
 *  shape covers all combinations without the 16-branch combinatorial
 *  explosion (vs the per-filter-branch pattern used in critic-panels). */
export async function listPublishedVideos(
  workspaceId: string,
  opts: {
    channelDbId?: string;
    scheduleItemId?: string;
    projectId?: string;
    statuses?: PublishStatus[];
    limit?: number;
  } = {},
): Promise<PublishedVideoRow[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const channelDbId = opts.channelDbId ?? null;
  const scheduleItemId = opts.scheduleItemId ?? null;
  const projectId = opts.projectId ?? null;
  // Pass NULL when no status filter is requested; the SQL treats NULL
  // as "match any". Postgres array literal syntax: '{a,b,c}'.
  const statusesArr = opts.statuses && opts.statuses.length > 0
    ? `{${opts.statuses.join(',')}}`
    : null;

  const { rows } = await sql<PublishedVideoRow>`
    SELECT
      id, workspace_id, channel_db_id, project_id, schedule_item_id,
      source_video_url,
      title, description, tags, category_id, default_language,
      privacy_status, publish_at::text AS publish_at, made_for_kids,
      thumbnail_url, playlist_id,
      youtube_video_id, youtube_url,
      status, upload_status, processing_status, privacy_status_actual, error_message,
      initiated_by,
      created_at::text AS created_at,
      updated_at::text AS updated_at,
      uploaded_at::text AS uploaded_at,
      live_at::text AS live_at
    FROM published_videos
    WHERE workspace_id = ${workspaceId}::uuid
      AND (${channelDbId}::uuid IS NULL OR channel_db_id = ${channelDbId}::uuid)
      AND (${scheduleItemId}::uuid IS NULL OR schedule_item_id = ${scheduleItemId}::uuid)
      AND (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
      AND (${statusesArr}::text[] IS NULL OR status = ANY(${statusesArr}::text[]))
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

/** Drain all rows currently in 'processing' across every workspace,
 *  polling YouTube for each and flipping to 'live' or 'failed' as
 *  appropriate. Used by the hourly cron so a user who closed the tab
 *  still sees the row update without revisiting the page.
 *
 *  Also marks long-stuck 'queued'/'uploading' rows as failed — those
 *  indicate the orchestrator process died mid-upload. Threshold is 1
 *  hour, generous enough that a slow CDN fetch + slow YouTube
 *  multipart push won't trigger it.
 *
 *  Returns counts so the cron route can log them. */
export async function pollAllPendingPublishes(opts: { limit?: number } = {}): Promise<{
  polled: number;
  flippedLive: number;
  flippedFailed: number;
  stuckFailed: number;
}> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));

  // Fail rows stuck in queued/uploading for > 1 hour. These can't make
  // progress without a fresh orchestrator run, so they're effectively
  // dead — better to mark them failed so the user can retry.
  const stuck = await sql`
    UPDATE published_videos
       SET status = 'failed',
           error_message = COALESCE(error_message || ' | ', '') ||
                           'Upload abandoned (> 1 hour with no progress).',
           updated_at = NOW()
     WHERE status IN ('queued', 'uploading')
       AND updated_at < NOW() - INTERVAL '1 hour'
  `;

  // Pick up everything in 'processing' to poll.
  const { rows: pending } = await sql<{ id: string; workspace_id: string }>`
    SELECT id, workspace_id
      FROM published_videos
     WHERE status = 'processing'
     ORDER BY updated_at ASC
     LIMIT ${limit}
  `;

  let flippedLive = 0;
  let flippedFailed = 0;
  for (const row of pending) {
    try {
      const res = await pollPublishStatus(row.id, row.workspace_id);
      if (res.status === 'live') flippedLive += 1;
      else if (res.status === 'failed') flippedFailed += 1;
    } catch (err) {
      logger.warn('publish: pollAll iteration failed', {
        id: row.id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    polled: pending.length,
    flippedLive,
    flippedFailed,
    stuckFailed: stuck.rowCount ?? 0,
  };
}

/** Single read, scoped to the workspace. Returns null when not found. */
export async function getPublishedVideo(
  id: string,
  workspaceId: string,
): Promise<PublishedVideoRow | null> {
  const { rows } = await sql<PublishedVideoRow>`
    SELECT
      id, workspace_id, channel_db_id, project_id, schedule_item_id,
      source_video_url,
      title, description, tags, category_id, default_language,
      privacy_status, publish_at::text AS publish_at, made_for_kids,
      thumbnail_url, playlist_id,
      youtube_video_id, youtube_url,
      status, upload_status, processing_status, privacy_status_actual, error_message,
      initiated_by,
      created_at::text AS created_at,
      updated_at::text AS updated_at,
      uploaded_at::text AS uploaded_at,
      live_at::text AS live_at
    FROM published_videos
    WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Producer events
// ---------------------------------------------------------------------------

/** Fire `video_published` to both the webhooks and workflows
 *  subsystems when a publish row flips to 'live'. Lazy imports keep
 *  the webhook + workflow deps out of every consumer of this module
 *  (mirrors the ab-tests / cannibalization pattern). Failures here
 *  are silently swallowed — never block the row's transition to
 *  'live' because of notification plumbing. */
async function emitVideoPublishedEvent(id: string, workspaceId: string): Promise<void> {
  const row = await getPublishedVideo(id, workspaceId).catch(() => null);
  if (!row || !row.youtube_video_id || !row.youtube_url) return;

  try {
    const { dispatchWebhookEvent } = await import('./webhooks');
    await dispatchWebhookEvent(workspaceId, {
      type: 'video_published',
      title: `🎉 Published: ${row.title}`,
      detail: `Live on YouTube — ${row.privacy_status_actual ?? row.privacy_status}.`,
      fields: {
        title: row.title.slice(0, 120),
        privacy: row.privacy_status_actual ?? row.privacy_status,
        youtube_video_id: row.youtube_video_id,
      },
      url: row.youtube_url,
    });
  } catch (err) {
    logger.warn('publish: webhook dispatch failed', {
      id,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { dispatchWorkflowEvent } = await import('./workflows');
    await dispatchWorkflowEvent(workspaceId, {
      type: 'video_published',
      payload: {
        publish_id: row.id,
        youtube_video_id: row.youtube_video_id,
        youtube_url: row.youtube_url,
        channel_db_id: row.channel_db_id,
        project_id: row.project_id,
        schedule_item_id: row.schedule_item_id,
        title: row.title,
        privacy_status: row.privacy_status_actual ?? row.privacy_status,
      },
    });
  } catch (err) {
    logger.warn('publish: workflow dispatch failed', {
      id,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

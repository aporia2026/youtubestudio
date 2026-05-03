/**
 * Pure types + helpers for the YouTube publishing pipeline.
 *
 * No DB or network deps — everything here is unit-testable. The
 * orchestrator that does the actual upload + DB writes lives in
 * `src/lib/publishing.ts`.
 */

export type PublishStatus =
  | 'queued'        // row created, upload not yet started
  | 'uploading'     // sending bytes to YouTube via videos.insert
  | 'processing'    // videos.insert succeeded, YouTube backend transcoding
  | 'live'          // YouTube reports uploadStatus=uploaded + processingStatus=succeeded
  | 'failed';       // terminal — see error_message

export type PrivacyStatus = 'private' | 'unlisted' | 'public';

export interface PublishedVideoRow {
  id: string;
  workspace_id: string;
  channel_db_id: string;
  project_id: string | null;
  schedule_item_id: string | null;
  source_video_url: string;
  title: string;
  description: string;
  tags: string[];
  category_id: string;
  default_language: string | null;
  privacy_status: PrivacyStatus;
  publish_at: string | null;
  made_for_kids: boolean;
  thumbnail_url: string | null;
  playlist_id: string | null;
  youtube_video_id: string | null;
  youtube_url: string | null;
  status: PublishStatus;
  upload_status: string | null;
  processing_status: string | null;
  privacy_status_actual: string | null;
  error_message: string | null;
  initiated_by: string | null;
  created_at: string;
  updated_at: string;
  uploaded_at: string | null;
  live_at: string | null;
}

/** Caller-supplied input for a publish request. The orchestrator
 *  validates these via `validatePublishRequest` before doing any
 *  DB or network work. */
export interface PublishRequest {
  workspaceId: string;
  channelDbId: string;
  projectId?: string | null;
  scheduleItemId?: string | null;
  sourceVideoUrl: string;
  title: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  privacyStatus?: PrivacyStatus;
  publishAt?: string | null;        // RFC3339 — only honoured when privacy=private and time is in the future
  madeForKids?: boolean;
  thumbnailUrl?: string | null;     // Vercel Blob URL or external https
  playlistId?: string | null;       // YouTube playlist id (e.g. PLxxx…)
  initiatedBy?: string | null;      // collaborator id
  /** Optional idempotency key (audit C7). When set, a retry with the
   *  SAME (workspaceId, idempotencyKey) returns the existing row's
   *  status instead of creating a duplicate publish row + duplicate
   *  YouTube upload. The route plumbs this from the
   *  `Idempotency-Key` HTTP header. */
  idempotencyKey?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** YouTube API limits as of May 2026. Centralised so tests stay in
 *  sync with reality and the route can quote them in 400 messages. */
export const PUBLISH_LIMITS = Object.freeze({
  TITLE_MAX: 100,
  DESCRIPTION_MAX: 5000,
  TAGS_MAX_TOTAL_LEN: 500,        // sum of all tag char-lengths
  TAGS_MAX_COUNT: 50,
  TAG_MAX_LEN: 30,
});

/** Validate a publish request. Returns a list of human-readable error
 *  strings; empty list means valid. The route maps a non-empty list to
 *  a 400 response. */
export function validatePublishRequest(req: PublishRequest): ValidationResult {
  const errors: string[] = [];

  if (!req.workspaceId) errors.push('workspaceId is required.');
  if (!req.channelDbId) errors.push('channelDbId is required.');
  if (!req.sourceVideoUrl) errors.push('sourceVideoUrl is required.');
  else if (!/^https:\/\//.test(req.sourceVideoUrl)) {
    // Audit C4 — only HTTPS sources accepted. The lib also runs
    // assertSafePublicUrl against this for SSRF protection.
    errors.push('sourceVideoUrl must be an https URL.');
  }

  const title = (req.title ?? '').trim();
  if (!title) errors.push('title is required.');
  else if (title.length > PUBLISH_LIMITS.TITLE_MAX) {
    errors.push(`title must be ${PUBLISH_LIMITS.TITLE_MAX} chars or fewer.`);
  }

  const description = req.description ?? '';
  if (description.length > PUBLISH_LIMITS.DESCRIPTION_MAX) {
    errors.push(`description must be ${PUBLISH_LIMITS.DESCRIPTION_MAX} chars or fewer.`);
  }

  if (req.tags) {
    if (req.tags.length > PUBLISH_LIMITS.TAGS_MAX_COUNT) {
      errors.push(`Up to ${PUBLISH_LIMITS.TAGS_MAX_COUNT} tags allowed.`);
    }
    const totalLen = req.tags.reduce((n, t) => n + t.length, 0);
    if (totalLen > PUBLISH_LIMITS.TAGS_MAX_TOTAL_LEN) {
      errors.push(`Combined tag length must be ${PUBLISH_LIMITS.TAGS_MAX_TOTAL_LEN} chars or fewer.`);
    }
    const oversized = req.tags.find((t) => t.length > PUBLISH_LIMITS.TAG_MAX_LEN);
    if (oversized !== undefined) {
      errors.push(`Tag "${oversized.slice(0, 20)}…" exceeds ${PUBLISH_LIMITS.TAG_MAX_LEN} chars.`);
    }
  }

  const privacy = req.privacyStatus ?? 'private';
  if (!['private', 'unlisted', 'public'].includes(privacy)) {
    errors.push('privacyStatus must be "private", "unlisted", or "public".');
  }

  if (req.publishAt) {
    const t = Date.parse(req.publishAt);
    if (Number.isNaN(t)) errors.push('publishAt must be a valid RFC3339 timestamp.');
    else if (privacy !== 'private') {
      // YouTube only honours publishAt when privacyStatus=private.
      // Setting it on unlisted/public is a silent no-op upstream — we
      // error out so the user knows their schedule won't apply.
      errors.push('publishAt is only honoured when privacyStatus is "private".');
    } else if (t <= Date.now()) {
      errors.push('publishAt must be in the future.');
    }
  }

  if (req.thumbnailUrl !== undefined && req.thumbnailUrl !== null) {
    if (!/^https:\/\//.test(req.thumbnailUrl)) {
      errors.push('thumbnailUrl must be an https URL.');
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Build the snippet portion of the videos.insert request body. */
export function buildVideosInsertSnippet(req: PublishRequest): {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  defaultLanguage?: string;
} {
  const snippet: ReturnType<typeof buildVideosInsertSnippet> = {
    title: req.title.trim(),
    description: req.description ?? '',
    tags: (req.tags ?? []).map((t) => t.trim()).filter(Boolean),
    categoryId: req.categoryId ?? '22',  // 22 = "People & Blogs"
  };
  if (req.defaultLanguage) snippet.defaultLanguage = req.defaultLanguage;
  return snippet;
}

/** Build the status portion of the videos.insert request body.
 *  publishAt is only attached when privacyStatus is 'private' AND the
 *  time is in the future — anything else makes YouTube reject or
 *  silently ignore it. */
export function buildVideosInsertStatus(req: PublishRequest): {
  privacyStatus: PrivacyStatus;
  selfDeclaredMadeForKids: boolean;
  publishAt?: string;
} {
  const privacy = req.privacyStatus ?? 'private';
  const status: ReturnType<typeof buildVideosInsertStatus> = {
    privacyStatus: privacy,
    selfDeclaredMadeForKids: req.madeForKids ?? false,
  };
  if (req.publishAt && privacy === 'private') {
    const t = Date.parse(req.publishAt);
    if (!Number.isNaN(t) && t > Date.now()) {
      status.publishAt = new Date(t).toISOString();
    }
  }
  return status;
}

/** Pure status state-machine. Returns the next valid status given
 *  the current one and an event. Throws on an illegal transition so
 *  bugs surface instead of leaving rows in undefined states. */
export type PublishEvent =
  | 'start_upload'
  | 'upload_succeeded'
  | 'upload_failed'
  | 'processing_complete'
  | 'processing_failed';

export function nextStatusFor(current: PublishStatus, event: PublishEvent): PublishStatus {
  switch (current) {
    case 'queued':
      if (event === 'start_upload') return 'uploading';
      if (event === 'upload_failed') return 'failed';
      break;
    case 'uploading':
      if (event === 'upload_succeeded') return 'processing';
      if (event === 'upload_failed') return 'failed';
      break;
    case 'processing':
      if (event === 'processing_complete') return 'live';
      if (event === 'processing_failed') return 'failed';
      break;
    case 'live':
    case 'failed':
      break;  // terminal — fall through to the throw
  }
  throw new Error(`Illegal publish-status transition: ${current} → ${event}`);
}

export function isTerminalStatus(s: PublishStatus): boolean {
  return s === 'live' || s === 'failed';
}

/** Build the canonical youtube.com URL from a videoId. Materialised
 *  on the row so the UI doesn't construct it (and so the format
 *  changing later means one update site). */
export function buildYoutubeUrl(videoId: string): string {
  return `https://youtu.be/${videoId}`;
}

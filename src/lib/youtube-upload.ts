/**
 * Resumable upload via `videos.insert` for new short videos.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Sibling of `src/lib/youtube-publish.ts`, which handles UPDATE
 * (snippet / thumbnail). This module handles INSERT — creating brand
 * new videos on a channel.
 *
 * Protocol (verified 2026-06-08 against
 * https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol):
 *   1. POST init session to /upload/youtube/v3/videos?uploadType=resumable
 *      with the snippet+status JSON body. Response carries a `Location`
 *      header — the upload session URL.
 *   2. PUT the video bytes to that URL. For files < 100 MB (typical
 *      vertical shorts top out at ~40 MB) a single PUT works; larger
 *      files would need chunked `Content-Range` uploads — out of scope
 *      for shorts, but the seam exists for a follow-up.
 *   3. The PUT response is the full video resource JSON.
 *
 * Quota (verified 2026-06-08 against
 * https://developers.google.com/youtube/v3/determine_quota_cost):
 *   videos.insert        100 units (was ~1600 before 2025-12-04)
 * Default daily quota is 10,000 units → ~100 uploads/day on the
 * default project. Quota is charged at insert time, NOT at publishAt
 * time — `youtube-quota.ts` records the charge before the API call so
 * a failure still costs the counter (matching YouTube's behavior).
 *
 * Read-only API gaps (verified 2026-06-08):
 *   - paidProductPlacementDetails.hasPaidProductPlacement — present
 *     on the resource but not writable via insert/update; the user
 *     must declare in YouTube Studio after upload.
 *   - contentDetails.contentRating.ytRating='ytAgeRestricted' — same
 *     situation: not writable via insert/update.
 * The uploader IGNORES `metadata.ageRestricted` and
 * `metadata.paidPromotion` at submission. The review-queue UI is
 * responsible for showing a "Finish in YouTube Studio" prompt with a
 * deep link to `https://studio.youtube.com/video/{videoId}/edit` for
 * any short with either flag set.
 */
import type {
  YoutubeUploadMetadata,
  YoutubeUploadResult,
  ShortYoutubeStatus,
} from './shorts-batches-types';
import { isValidYoutubeCategoryId, DEFAULT_YOUTUBE_CATEGORY_ID } from './youtube-categories';

const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3/videos';

/** Hard limits enforced by YouTube. Surfaced as constants so the UI
 *  guards (TagTokenInput, title char counter) reference the same
 *  numbers the uploader validates against. */
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
/** Combined tag length includes comma separators — verified by
 *  manually probing the API in 2024 (returned a tagTooLong error
 *  when `tags.join(',').length > 500`). */
export const YOUTUBE_TAGS_COMBINED_MAX = 500;

/** Quota units charged by `videos.insert`. Surfaced so
 *  `youtube-quota.ts` and the UI quota meter both reference the
 *  same constant. */
export const VIDEOS_INSERT_QUOTA_UNITS = 100;

/** Validation failure — caller maps to a 400 / user-visible toast.
 *  Errors are deliberately specific so the UI can highlight the
 *  offending field instead of showing a generic "upload failed". */
export class YoutubeUploadValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
    this.name = 'YoutubeUploadValidationError';
  }
}

/** Upstream API failure — caller maps to a retry-eligible state. */
export class YoutubeUploadApiError extends Error {
  constructor(public status: number, public youtubeReason: string | null, message: string) {
    super(message);
    this.name = 'YoutubeUploadApiError';
  }
}

/** Combined tag length per YouTube's accounting (entries joined by
 *  comma). Exported because the TagTokenInput component uses the
 *  same math for its char-count guard. */
export function combinedTagsLength(tags: readonly string[]): number {
  return tags.join(',').length;
}

/** Build the `snippet` block from the editable metadata. Throws
 *  `YoutubeUploadValidationError` on any hard-limit violation so
 *  the caller can refuse the upload before the API call. */
export function buildSnippetBody(metadata: YoutubeUploadMetadata): {
  title: string;
  description: string;
  categoryId: string;
  tags?: string[];
  defaultLanguage?: string;
} {
  const title = metadata.title?.trim();
  if (!title) {
    throw new YoutubeUploadValidationError('title', 'Title is required.');
  }
  if (title.length > YOUTUBE_TITLE_MAX) {
    throw new YoutubeUploadValidationError(
      'title',
      `Title is ${title.length} chars; YouTube max is ${YOUTUBE_TITLE_MAX}.`,
    );
  }

  const description = metadata.description ?? '';
  if (description.length > YOUTUBE_DESCRIPTION_MAX) {
    throw new YoutubeUploadValidationError(
      'description',
      `Description is ${description.length} chars; YouTube max is ${YOUTUBE_DESCRIPTION_MAX}.`,
    );
  }

  const categoryId = metadata.categoryId || DEFAULT_YOUTUBE_CATEGORY_ID;
  if (!isValidYoutubeCategoryId(categoryId)) {
    throw new YoutubeUploadValidationError(
      'categoryId',
      `Category id "${categoryId}" is not assignable for upload.`,
    );
  }

  const snippet: ReturnType<typeof buildSnippetBody> = { title, description, categoryId };

  if (metadata.tags && metadata.tags.length > 0) {
    const total = combinedTagsLength(metadata.tags);
    if (total > YOUTUBE_TAGS_COMBINED_MAX) {
      throw new YoutubeUploadValidationError(
        'tags',
        `Combined tag length is ${total} chars (YouTube counts comma separators); max is ${YOUTUBE_TAGS_COMBINED_MAX}.`,
      );
    }
    snippet.tags = [...metadata.tags];
  }

  if (metadata.defaultLanguage) {
    snippet.defaultLanguage = metadata.defaultLanguage;
  }

  return snippet;
}

/** Build the `status` block from the editable metadata + scheduling.
 *  Encodes the publishAt rule: when scheduled, privacyStatus MUST be
 *  'private' at insert (YouTube flips to the target privacy at
 *  publishAt). `selfDeclaredMadeForKids` is mandatory — refuse if
 *  absent because YouTube rejects without it. `containsSyntheticMedia`
 *  defaults to true for this pipeline (we generate with AI).
 *  Read-only fields (ageRestricted, paidPromotion) are intentionally
 *  NOT serialized here. */
export function buildStatusBody(args: {
  metadata: YoutubeUploadMetadata;
  publishAtUtc?: string | null;
}): {
  privacyStatus: 'public' | 'private' | 'unlisted';
  publishAt?: string;
  selfDeclaredMadeForKids: boolean;
  containsSyntheticMedia: boolean;
  embeddable: boolean;
  publicStatsViewable: boolean;
} {
  const { metadata, publishAtUtc } = args;

  if (metadata.madeForKids === undefined) {
    throw new YoutubeUploadValidationError(
      'madeForKids',
      'Made-for-kids must be set explicitly — YouTube requires a COPPA declaration on every upload.',
    );
  }

  let privacyStatus: 'public' | 'private' | 'unlisted';
  let publishAt: string | undefined;

  if (publishAtUtc) {
    // YouTube only honors publishAt when privacyStatus=private at
    // insert. The video flips to the metadata.privacy value at the
    // scheduled time. Reject past dates client-side here so the API
    // never sees a malformed schedule.
    const ts = Date.parse(publishAtUtc);
    if (Number.isNaN(ts)) {
      throw new YoutubeUploadValidationError('publishAt', `publishAt is not a valid ISO timestamp: ${publishAtUtc}`);
    }
    if (ts <= Date.now()) {
      throw new YoutubeUploadValidationError('publishAt', 'publishAt must be in the future.');
    }
    privacyStatus = 'private';
    publishAt = new Date(ts).toISOString();
  } else {
    privacyStatus = metadata.privacy ?? 'private';
  }

  return {
    privacyStatus,
    ...(publishAt ? { publishAt } : {}),
    selfDeclaredMadeForKids: metadata.madeForKids,
    // Default to true since this pipeline generates with AI; per-short
    // override (e.g. obviously stylised doodle) flips to false in the
    // review queue.
    containsSyntheticMedia: metadata.aiContentDisclosure ?? true,
    embeddable: true,
    publicStatsViewable: true,
  };
}

/** Resolve the final `youtube_status` for the short row from the
 *  videos.insert response. Used by the uploader after a successful
 *  call. */
export function resolveShortYoutubeStatus(publishAtUtc: string | null): ShortYoutubeStatus {
  return publishAtUtc ? 'scheduled' : 'uploaded';
}

export interface UploadVideoArgs {
  accessToken: string;
  metadata: YoutubeUploadMetadata;
  /** Raw video bytes. Caller is responsible for fetching from R2 (or
   *  wherever the rendered video lives) and validating the size. */
  videoBytes: Buffer;
  /** ISO 8601 UTC publishAt timestamp, or null for "publish at the
   *  privacy value immediately". */
  publishAtUtc?: string | null;
  /** Video MIME type. Almost always 'video/mp4' for our renders;
   *  exposed so a future format change doesn't require a code edit. */
  contentType?: string;
}

/**
 * Upload a new video via the resumable protocol. Single-shot PUT for
 * the bytes; we never see uploads > 100 MB in this pipeline.
 *
 * Throws `YoutubeUploadValidationError` on metadata problems (before
 * any network call) and `YoutubeUploadApiError` on upstream failure.
 * Success returns the video id + resolved status.
 *
 * The caller is responsible for: token refresh (`getValidAccessToken`),
 * quota charge accounting (`youtube-quota.ts`), and persisting the
 * returned id on the short row. This module deals only with the wire.
 */
export async function uploadVideo(args: UploadVideoArgs): Promise<YoutubeUploadResult> {
  const { accessToken, metadata, videoBytes, publishAtUtc = null, contentType = 'video/mp4' } = args;

  const snippet = buildSnippetBody(metadata);
  const status = buildStatusBody({ metadata, publishAtUtc });
  const body = JSON.stringify({ snippet, status });

  console.info('[shorts-upload start]', {
    title: snippet.title,
    bytes: videoBytes.byteLength,
    scheduled: publishAtUtc !== null,
    privacy_at_insert: status.privacyStatus,
    made_for_kids: status.selfDeclaredMadeForKids,
    synthetic_media: status.containsSyntheticMedia,
  });

  // Step 1 — initiate the resumable session.
  const initRes = await fetch(
    `${UPLOAD_BASE}?uploadType=resumable&part=snippet,status`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(videoBytes.byteLength),
      },
      body,
    },
  );

  if (!initRes.ok) {
    const reason = await parseYoutubeError(initRes);
    console.info('[shorts-upload error]', { stage: 'init', http: initRes.status, reason });
    throw new YoutubeUploadApiError(initRes.status, reason, `Resumable init failed (${initRes.status}): ${reason ?? 'no detail'}`);
  }

  const uploadUrl = initRes.headers.get('location') ?? initRes.headers.get('Location');
  if (!uploadUrl) {
    throw new YoutubeUploadApiError(initRes.status, null, 'Resumable init succeeded but no Location header — cannot upload bytes.');
  }

  // Step 2 — PUT the bytes in a single shot. Vertical shorts top out
  // around 40 MB; chunked uploads (`Content-Range: bytes 0-N/total`)
  // would only matter for files > 100 MB and are out of scope.
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(videoBytes.byteLength),
    },
    body: new Uint8Array(videoBytes),
  });

  if (!putRes.ok) {
    const reason = await parseYoutubeError(putRes);
    console.info('[shorts-upload error]', { stage: 'put', http: putRes.status, reason });
    throw new YoutubeUploadApiError(putRes.status, reason, `Resumable PUT failed (${putRes.status}): ${reason ?? 'no detail'}`);
  }

  const payload = (await putRes.json()) as { id?: string; status?: { publishAt?: string } };
  if (!payload.id) {
    throw new YoutubeUploadApiError(putRes.status, null, 'PUT succeeded but response had no video id.');
  }

  const finalStatus = resolveShortYoutubeStatus(publishAtUtc);
  console.info('[shorts-upload complete]', {
    video_id: payload.id,
    status: finalStatus,
    publish_at: publishAtUtc,
  });

  return {
    videoId: payload.id,
    status: finalStatus,
    publishAtUtc: publishAtUtc,
  };
}

/** Best-effort parse of YouTube's error body. The API consistently
 *  returns `{ error: { errors: [{ reason }], message } }`; we extract
 *  the most-specific string available without throwing on a malformed
 *  body so the caller's error message stays informative. */
async function parseYoutubeError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as {
      error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> };
    };
    const first = body.error?.errors?.[0];
    return first?.reason ?? first?.message ?? body.error?.message ?? null;
  } catch {
    return null;
  }
}

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let _r2Client: S3Client | null = null;

function getR2Client() {
  if (_r2Client) return _r2Client;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2 environment variables (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  }

  _r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _r2Client;
}

// ---------------------------------------------------------------------------
// Generic bucket-aware helpers
// ---------------------------------------------------------------------------

export function isR2Configured(): boolean {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

export async function getUploadUrlForBucket(bucket: string, key: string, contentType: string): Promise<string> {
  const client = getR2Client();
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  // 4 hours. Browsers compress + PUT large videos sequentially, and on
  // home-grade upload bandwidth a 4 GB compressed render can take 1-2h to
  // finish a single PUT. The previous 1h TTL silently 403'd mid-upload —
  // the XHR surfaced it as a generic network error after a long delay,
  // looking like a hang. 4h covers the realistic worst case; anything past
  // that is a connection problem we can't paper over with TTL.
  return getSignedUrl(client, command, { expiresIn: 4 * 60 * 60 });
}

export async function getDownloadUrlForBucket(bucket: string, key: string, publicBaseUrl?: string): Promise<string> {
  if (publicBaseUrl) {
    return `${publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
  const client = getR2Client();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  // 7 days. R2/S3 presigned URLs sign individual byte-range GETs, but the
  // browser holds onto the URL across an entire review session and will
  // start failing range requests the moment the URL expires — surfaced as
  // mid-playback stalls. A 24h TTL frequently expires inside a single
  // workday (URL minted in the morning, video opened that evening).
  return getSignedUrl(client, command, { expiresIn: 60 * 60 * 24 * 7 });
}

export async function deleteFromBucket(bucket: string, key: string): Promise<void> {
  const client = getR2Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Upload bytes server-side directly to R2 (no presigned PUT round-trip).
 * For routes that already have the file content in memory — e.g. an
 * ElevenLabs voiceover ArrayBuffer or a finished Remotion render — going
 * through a presigned PUT would mean a pointless extra hop.
 */
export async function uploadToBucket(
  bucket: string,
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const client = getR2Client();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

// ---------------------------------------------------------------------------
// Review videos bucket (existing behaviour, kept for back-compat)
// ---------------------------------------------------------------------------

export function getReviewBucket(): string {
  return process.env.R2_BUCKET_NAME || 'videos';
}

/** Generate a presigned PUT URL for direct browser → R2 upload (1-hour expiry). */
export async function getUploadPresignedUrl(key: string, contentType: string): Promise<string> {
  return getUploadUrlForBucket(getReviewBucket(), key, contentType);
}

/** Generate a presigned GET URL for video playback (24-hour expiry). */
export async function getDownloadPresignedUrl(key: string): Promise<string> {
  return getDownloadUrlForBucket(getReviewBucket(), key, process.env.R2_PUBLIC_URL);
}

/** Delete an object from the review videos bucket. */
export async function deleteR2Object(key: string): Promise<void> {
  return deleteFromBucket(getReviewBucket(), key);
}

/** Build a consistent R2 key for review videos. */
export function buildR2Key(projectId: string, versionNumber: number, fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const timestamp = Date.now();
  return `reviews/${projectId}/v${versionNumber}/${timestamp}-${sanitized}`;
}

/** Build an R2 key for a long-form video render output. Lives in the
 *  review/videos bucket under a `renders/` prefix so the bucket listing
 *  separates reviewer uploads from Remotion outputs. */
export function buildRenderKey(renderId: string): string {
  return `renders/${renderId}.mp4`;
}

/** Build an R2 key for a Shorts render output. Separate prefix so the
 *  Shorts feed listing doesn't intermix with long-form renders. */
export function buildShortRenderKey(renderId: string): string {
  return `shorts-renders/${renderId}.mp4`;
}

// ---------------------------------------------------------------------------
// Narration bucket — separate bucket for narrator audio takes
// ---------------------------------------------------------------------------

export function getNarrationBucket(): string {
  return process.env.R2_NARRATION_BUCKET_NAME || 'narration';
}

/** Presigned PUT URL for direct browser → R2 upload to the narration bucket. */
export async function getNarrationUploadUrl(key: string, contentType: string): Promise<string> {
  return getUploadUrlForBucket(getNarrationBucket(), key, contentType);
}

/** Presigned GET URL for audio playback from the narration bucket (24h expiry). */
export async function getNarrationDownloadUrl(key: string): Promise<string> {
  return getDownloadUrlForBucket(getNarrationBucket(), key, process.env.R2_NARRATION_PUBLIC_URL);
}

/** Delete a narration audio object from R2. */
export async function deleteNarrationObject(key: string): Promise<void> {
  return deleteFromBucket(getNarrationBucket(), key);
}

/** Build a consistent R2 key for a narrator take. */
export function buildNarrationKey(assignmentId: string, sectionId: string, takeNumber: number, fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `assignments/${assignmentId}/sections/${sectionId}/take-${takeNumber}-${Date.now()}-${sanitized}`;
}

/**
 * Build an R2 key for an ElevenLabs-generated voiceover. Lives in the
 * narration bucket under an `elevenlabs/` prefix so the bucket's
 * directory listing groups AI-generated voiceovers separately from
 * human narrator takes (`assignments/...`).
 */
export function buildElevenLabsVoiceoverKey(voiceId: string): string {
  const sanitized = voiceId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `elevenlabs/${Date.now()}-${sanitized}.mp3`;
}

/**
 * Build an R2 key for a Shorts voiceover. Distinct prefix from long-form
 * narration so the bucket listing separates the two formats.
 */
export function buildShortVoiceoverKey(shortId: string, voiceId: string): string {
  const safeShort = shortId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeVoice = voiceId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `shorts/${safeShort}/voiceover-${Date.now()}-${safeVoice}.mp3`;
}

/**
 * Build an R2 key for stitched narrator audio (multi-section take
 * concatenated into a single MP3 for the production render).
 */
export function buildStitchedNarrationKey(assignmentId: string): string {
  return `stitched/${assignmentId}/${Date.now()}.mp3`;
}

/**
 * Build an R2 key for a dubbed-language audio track. The dubbing
 * pipeline can run with `projectId: null` (one-shot dub of a freeform
 * script), so the project segment falls back to `unattached` in that
 * case — keeps the prefix consistent and groups orphan dubs together.
 */
export function buildDubbingKey(projectId: string | null, language: string): string {
  const safeLang = language.replace(/[^a-zA-Z0-9._-]/g, '_');
  const segment = projectId || 'unattached';
  return `dubbing/${segment}/${safeLang}-${Date.now()}.mp3`;
}

/**
 * Stream an object out of the narration bucket with optional Range support.
 * Used by the audio-proxy routes so the browser fetches audio same-origin
 * (no CORS dance, no presigned-URL expiry inside a long review session).
 *
 * Forwards a Range header verbatim if present — R2/S3 honour byte-range
 * GETs natively. Returns the AWS SDK response so the caller can echo
 * the relevant headers (Content-Type, Content-Length, Accept-Ranges,
 * Content-Range) back to the browser; without those audio seek goes
 * sequential and waveform decode bloats memory.
 */
export async function streamFromNarrationBucket(
  key: string,
  range?: string | null,
): Promise<{
  body: ReadableStream<Uint8Array> | null;
  contentType: string | null;
  contentLength: number | null;
  contentRange: string | null;
  acceptRanges: string | null;
  status: 200 | 206;
}> {
  const client = getR2Client();
  const command = new GetObjectCommand({
    Bucket: getNarrationBucket(),
    Key: key,
    Range: range || undefined,
  });
  const res = await client.send(command);
  // res.Body in the AWS SDK v3 web build is a ReadableStream when running
  // on the Node 18+ / Edge runtime fetch transport. Cast accordingly —
  // older Node-stream variants are not in our deploy targets.
  const body = (res.Body as unknown as ReadableStream<Uint8Array>) ?? null;
  return {
    body,
    contentType: res.ContentType ?? null,
    contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : null,
    contentRange: res.ContentRange ?? null,
    acceptRanges: res.AcceptRanges ?? 'bytes',
    status: range && res.ContentRange ? 206 : 200,
  };
}

// ---------------------------------------------------------------------------
// Images bucket — image references + thumbnails (and any other static images)
// ---------------------------------------------------------------------------

export function getImagesBucket(): string {
  return process.env.R2_IMAGES_BUCKET_NAME || 'images';
}

/** Presigned PUT URL for direct browser → R2 upload to the images bucket. */
export async function getImagesUploadUrl(key: string, contentType: string): Promise<string> {
  return getUploadUrlForBucket(getImagesBucket(), key, contentType);
}

/** Presigned GET URL for image download from the images bucket (24h expiry). */
export async function getImagesDownloadUrl(key: string): Promise<string> {
  return getDownloadUrlForBucket(getImagesBucket(), key, process.env.R2_IMAGES_PUBLIC_URL);
}

/** Delete an image object from R2 images bucket. */
export async function deleteImagesObject(key: string): Promise<void> {
  return deleteFromBucket(getImagesBucket(), key);
}

/** Build an R2 key for a project image reference. */
export function buildImageRefKey(projectId: string, fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `references/${projectId}/${Date.now()}-${sanitized}`;
}

/** Build an R2 key for a project thumbnail (lives in the thumbnails/ prefix). */
export function buildThumbnailKey(projectId: string, fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `thumbnails/${projectId}/${Date.now()}-${sanitized}`;
}

/** Build an R2 key for a transient reference image used as input to the
 *  thumbnail concept generator. No project scoping — these are uploaded
 *  from the standalone thumbnails page before any project exists. */
export function buildThumbnailReferenceKey(fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `thumbnail-refs/${Date.now()}-${sanitized}`;
}

/** Build an R2 key for an uploaded production-doc attachment (PDF/DOCX/XLSX/
 *  CSV/TXT/JSON). Lives in the images bucket under a prod-docs/ prefix —
 *  treats that bucket as a generic static-asset store rather than spinning
 *  up another bucket just for documents. */
export function buildProductionDocKey(projectId: string, fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `prod-docs/${projectId}/${Date.now()}-${sanitized}`;
}

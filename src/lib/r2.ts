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
  return getSignedUrl(client, command, { expiresIn: 3600 });
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

// ---------------------------------------------------------------------------
// Review videos bucket (existing behaviour, kept for back-compat)
// ---------------------------------------------------------------------------

function getReviewBucket(): string {
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

// ---------------------------------------------------------------------------
// Narration bucket — separate bucket for narrator audio takes
// ---------------------------------------------------------------------------

function getNarrationBucket(): string {
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

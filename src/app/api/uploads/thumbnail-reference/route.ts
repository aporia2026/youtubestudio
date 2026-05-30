import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  isR2Configured,
  buildThumbnailReferenceKey,
  deleteImagesObject,
  getImagesUploadUrl,
  getImagesDownloadUrl,
} from '@/lib/r2';
import { logger } from '@/lib/logger';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Issue a presigned PUT URL so the browser can upload a thumbnail reference
 * image straight to the R2 images bucket. Bypasses Vercel's ~4.5 MB API
 * request body limit, which the old FormData → /api/upload path tripped
 * over for typical phone-camera photos.
 *
 * Reference images are transient — they're only used as input to the image
 * concept generator and aren't tied to any project, so this route writes
 * nothing to the DB. The caller stores the returned downloadUrl in
 * component state and passes it to the generator.
 *
 * Authed: anonymous callers shouldn't be able to mint presigned URLs
 * against our bucket. The legacy /api/upload route is unauthenticated;
 * we deliberately do not carry that mistake forward.
 */
export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const { fileName, contentType, fileSize } = await req.json();
  if (!fileName || !contentType) {
    return NextResponse.json({ error: 'fileName + contentType required' }, { status: 400 });
  }
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
    return NextResponse.json({ error: `Unsupported image type: ${contentType}` }, { status: 400 });
  }
  if (typeof fileSize === 'number' && fileSize > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'Image too large (max 20MB)' }, { status: 400 });
  }

  const r2Key = buildThumbnailReferenceKey(String(fileName));
  let uploadUrl: string;
  let downloadUrl: string;
  try {
    uploadUrl = await getImagesUploadUrl(r2Key, contentType);
    downloadUrl = await getImagesDownloadUrl(r2Key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown R2 error';
    return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
  }

  return NextResponse.json({ uploadUrl, downloadUrl, r2Key }, { status: 201 });
});

/**
 * Delete a previously-uploaded reference image from R2 so the bucket
 * doesn't accumulate orphaned bytes once the user moves on from a
 * concept. The thumbnails page calls this from the "remove" affordance
 * next to the preview thumbnail.
 *
 * Authed: same surface as POST — only signed-in users can issue deletes
 * against our bucket. We additionally restrict the key prefix to
 * `thumbnail-refs/`, the only prefix this route ever mints, so an authed
 * caller cannot use this endpoint to delete unrelated images (project
 * thumbnails, narration art, cell uploads, etc.) by guessing keys.
 */
export const DELETE = apiRoute.authed(async (_session, req: NextRequest) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const { r2Key } = await req.json().catch(() => ({}));
  if (typeof r2Key !== 'string' || !r2Key) {
    return NextResponse.json({ error: 'r2Key required' }, { status: 400 });
  }
  if (!r2Key.startsWith('thumbnail-refs/')) {
    return NextResponse.json(
      { error: 'Refusing to delete keys outside thumbnail-refs/' },
      { status: 400 },
    );
  }

  try {
    await deleteImagesObject(r2Key);
    logger.info('[thumbnail-reference delete]', { r2Key });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown R2 error';
    logger.warn('[thumbnail-reference delete failed]', { r2Key, detail: msg });
    return NextResponse.json({ error: `R2 delete failed: ${msg}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
});

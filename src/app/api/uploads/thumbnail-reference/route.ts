import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  isR2Configured,
  buildThumbnailReferenceKey,
  getImagesUploadUrl,
  getImagesDownloadUrl,
} from '@/lib/r2';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

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
    return NextResponse.json({ error: 'Image too large (max 10MB)' }, { status: 400 });
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

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  buildUserUploadKey,
  getImagesDownloadUrl,
  getImagesUploadUrl,
  isR2Configured,
} from '@/lib/r2';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Mint a presigned PUT URL so the browser can upload an image straight to
 * R2 (bypassing Vercel's ~4.5 MB API body cap). The caller persists the
 * returned `downloadUrl` onto the row's state — there is no DB write here.
 *
 * Distinct from /api/uploads/thumbnail-reference (which uses the
 * `thumbnail-refs/` prefix and is shaped around the thumbnails surface);
 * this route writes under `user-uploads/` so production-doc uploads aren't
 * mixed with thumbnail references in bucket browsing or lifecycle rules.
 *
 * Authed. Anonymous callers should not be able to mint presigned URLs
 * against the bucket.
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

  const r2Key = buildUserUploadKey(String(fileName));
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

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  isR2Configured,
  buildFlexIconGridCellUploadKey,
  getImagesUploadUrl,
  getImagesDownloadUrl,
} from '@/lib/r2';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 8 * 1024 * 1024;

/**
 * Issue a presigned PUT URL so the browser can upload a per-cell image
 * directly to R2 for the Flex Icon Grid format. Mirrors
 * `/api/uploads/topic-card-grid-cell` deliberately — same auth gate,
 * same R2 helpers, same MIME / size limits, different key prefix so
 * the per-cell uploads can be audited / lifecycle-managed
 * independently of the sibling format.
 *
 * Authed: anonymous callers shouldn't be able to mint presigned URLs
 * against our bucket.
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
    return NextResponse.json({ error: 'Image too large (max 8MB)' }, { status: 400 });
  }

  const r2Key = buildFlexIconGridCellUploadKey(String(fileName));
  let uploadUrl: string;
  let downloadUrl: string;
  try {
    uploadUrl = await getImagesUploadUrl(r2Key, contentType);
    downloadUrl = await getImagesDownloadUrl(r2Key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown R2 error';
    return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
  }

  console.info('[flex-icon-grid upload] presign issued', {
    r2_key: r2Key, content_type: contentType, size_bytes: fileSize,
  });
  return NextResponse.json({ uploadUrl, downloadUrl, r2Key }, { status: 201 });
});

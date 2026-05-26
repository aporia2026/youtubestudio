import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  isR2Configured,
  buildTopicCardGridCellUploadKey,
  getImagesUploadUrl,
  getImagesDownloadUrl,
} from '@/lib/r2';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 8 * 1024 * 1024;

/**
 * Issue a presigned PUT URL so the browser can upload a per-cell image
 * directly to R2, bypassing Vercel's ~4.5 MB API body cap. Used by the
 * Topic Card Grid panel — the user attaches an image to a specific cell
 * instead of writing an icon_concept prompt, and the server-side
 * compositor pastes the bytes into the cell after the AI image renders.
 *
 * Mirrors `/api/uploads/thumbnail-reference` deliberately — same auth
 * gate, same R2 helpers, different key prefix so the per-cell uploads
 * can be audited / lifecycle-managed independently. The 8 MB cap
 * matches the plan in
 * `_plans/2026-05-19-topic-card-grid-circles-and-uploads.md`.
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

  const r2Key = buildTopicCardGridCellUploadKey(String(fileName));
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

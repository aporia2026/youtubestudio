import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  buildMaskKey,
  getImagesDownloadUrl,
  getImagesUploadUrl,
  isR2Configured,
} from '@/lib/r2';

const ALLOWED_MASK_TYPES = ['image/png'];
const MAX_MASK_SIZE = 8 * 1024 * 1024;

/**
 * Mint a presigned PUT URL for a transient mask image used as input to
 * the GPT-4o image edit endpoint.
 *
 * Masks are write-once, single-use — the GPT-4o task reads the mask URL
 * once and never needs it again. They live under `mask-uploads/` so they
 * can be garbage-collected by an R2 lifecycle rule (configured at infra
 * level — not enforced here).
 *
 * Restricted to PNG: the GPT-4o edit endpoint expects a binary mask
 * (black = edit, white = preserve) and JPEG lossy compression bleeds
 * those values into greys near the brush boundary. PNG keeps the
 * mask crisp.
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
  if (!ALLOWED_MASK_TYPES.includes(contentType)) {
    return NextResponse.json({ error: 'Mask must be image/png' }, { status: 400 });
  }
  if (typeof fileSize === 'number' && fileSize > MAX_MASK_SIZE) {
    return NextResponse.json({ error: 'Mask too large (max 8MB)' }, { status: 400 });
  }

  const r2Key = buildMaskKey(String(fileName));
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

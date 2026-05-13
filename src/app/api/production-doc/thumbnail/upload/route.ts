import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

/**
 * POST /api/production-doc/thumbnail/upload
 *
 * Receive a composite section-divider thumbnail image, store it in
 * Vercel Blob, and return its URL plus intrinsic dimensions for the
 * region editor's pixel-coord math.
 *
 * The image is intrinsic to ONE production-doc and never reused, so it
 * lives in Vercel Blob (simpler than the R2 presign dance used for
 * media-library uploads) and the URL ends up inside the doc's JSON
 * (`ProductionDoc.thumbnail.imageUrl`) — no media_assets row, no
 * project association needed. See
 * `_plans/2026-05-13-thumbnail-zoom-section-divider.md`.
 *
 * Body: multipart/form-data with fields:
 *   file   : the image (image/jpeg | image/png | image/webp, ≤ 5 MB)
 *   width  : intrinsic pixel width  (client-extracted)
 *   height : intrinsic pixel height (client-extracted)
 *
 * Returns: { url, width, height, size }
 *
 * Auth: required. Workspace scope is implicit — the URL is public-Blob
 * and is only useful when paired with the doc that holds it.
 */

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_FILE_SIZE = 5 * 1024 * 1024;             // 5 MB
const MAX_INTRINSIC_DIMENSION = 8192;              // 8K per axis

export const maxDuration = 30;

export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart body' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type as typeof ALLOWED_IMAGE_TYPES[number])) {
    return NextResponse.json(
      { error: `Unsupported image type: ${file.type}. Use JPEG, PNG, or WebP.` },
      { status: 400 },
    );
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB.` },
      { status: 400 },
    );
  }

  const width = Number(formData.get('width'));
  const height = Number(formData.get('height'));
  if (
    !Number.isFinite(width) || !Number.isFinite(height) ||
    width <= 0 || height <= 0 ||
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width > MAX_INTRINSIC_DIMENSION || height > MAX_INTRINSIC_DIMENSION
  ) {
    return NextResponse.json(
      { error: 'Invalid width/height. Must be positive integers up to 8192.' },
      { status: 400 },
    );
  }

  // Pathname is timestamp + suffix from put(). addRandomSuffix prevents
  // a re-upload collision when the user replaces the thumbnail on the
  // same doc — old URL stays valid until the doc points elsewhere.
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 60) || 'thumbnail.png';
  const pathname = `production-doc-thumbnails/${Date.now()}-${safeName}`;

  try {
    const blob = await put(pathname, file, {
      access: 'public',
      contentType: file.type,
      addRandomSuffix: true,
    });
    return NextResponse.json({
      url: blob.url,
      width,
      height,
      size: file.size,
    });
  } catch (err) {
    logger.error('production-doc-thumbnail upload failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Failed to upload thumbnail. Try again in a moment.' },
      { status: 502 },
    );
  }
});

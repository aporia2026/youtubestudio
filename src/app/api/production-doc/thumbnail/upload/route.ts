import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  isR2Configured,
  getImagesUploadUrl,
  getImagesDownloadUrl,
} from '@/lib/r2';

/**
 * POST /api/production-doc/thumbnail/upload
 *
 * Issue a presigned PUT URL so the browser can upload a composite
 * section-divider thumbnail image directly to the R2 images bucket,
 * then return the public/signed read URL the production doc embeds.
 *
 * Migrated from Vercel Blob to R2 in 2026-05-14 to align with every
 * other image upload in the app (thumbnail references, AI-generated
 * production-doc images). The Blob path was wedged on workspaces
 * whose Vercel Blob store is configured as private-access — `put(
 * ..., { access: 'public' })` errors with "Cannot use public access
 * on a private store." R2 has no equivalent split, so the same code
 * path works on every workspace.
 *
 * The image is intrinsic to ONE production doc and never reused. The
 * returned URL lives inside the doc's JSON (`ProductionDoc.thumbnail.
 * imageUrl`) and persists with the doc via the existing history flow
 * — no media_assets row, no project association needed. See
 * `_plans/2026-05-13-thumbnail-zoom-section-divider.md`.
 *
 * Body (JSON):
 *   fileName    : string  — original file name, used to sanitise the
 *                           R2 key
 *   contentType : string  — image/jpeg | image/png | image/webp
 *   fileSize    : number  — bytes; rejected if > 5 MB
 *   width       : number  — intrinsic pixel width  (client-extracted)
 *   height      : number  — intrinsic pixel height (client-extracted)
 *
 * Returns: { uploadUrl, downloadUrl, r2Key, width, height }
 *
 * The client PUTs the file directly to `uploadUrl` with the matching
 * Content-Type header, then writes `downloadUrl` into the doc.
 *
 * Auth: required. Workspace scope is implicit — the URL is only
 * useful when paired with the doc that holds it.
 */

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_FILE_SIZE = 5 * 1024 * 1024;             // 5 MB
const MAX_INTRINSIC_DIMENSION = 8192;              // 8K per axis

export const maxDuration = 30;

export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const fileName = typeof b.fileName === 'string' ? b.fileName : '';
  const contentType = typeof b.contentType === 'string' ? b.contentType : '';
  const fileSize = typeof b.fileSize === 'number' ? b.fileSize : -1;
  const width = typeof b.width === 'number' ? b.width : NaN;
  const height = typeof b.height === 'number' ? b.height : NaN;

  if (!fileName) {
    return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
  }
  if (!ALLOWED_IMAGE_TYPES.includes(contentType as typeof ALLOWED_IMAGE_TYPES[number])) {
    return NextResponse.json(
      { error: `Unsupported image type: ${contentType}. Use JPEG, PNG, or WebP.` },
      { status: 400 },
    );
  }
  if (fileSize < 0 || fileSize > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `Image too large or fileSize missing. Max ${MAX_FILE_SIZE / 1024 / 1024} MB.` },
      { status: 400 },
    );
  }
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

  // Sanitise the filename, prefix with a `production-doc-thumbnails/`
  // namespace so the bucket's directory listing groups them together,
  // and stamp a millisecond timestamp so two uploads of the same name
  // never collide.
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 60) || 'thumbnail.png';
  const r2Key = `production-doc-thumbnails/${Date.now()}-${safeName}`;

  let uploadUrl: string;
  let downloadUrl: string;
  try {
    uploadUrl = await getImagesUploadUrl(r2Key, contentType);
    downloadUrl = await getImagesDownloadUrl(r2Key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown R2 error';
    return NextResponse.json(
      { error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' },
      { status: 502 },
    );
  }

  return NextResponse.json(
    { uploadUrl, downloadUrl, r2Key, width, height },
    { status: 201 },
  );
});

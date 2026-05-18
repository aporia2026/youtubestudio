import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { resolveAndPinSafeUrl } from '@/lib/url-safety';
import {
  buildUserUploadKey,
  getDownloadUrlForBucket,
  getImagesBucket,
  isR2Configured,
  uploadToBucket,
} from '@/lib/r2';

export const maxDuration = 60;

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Import an image from an external HTTPS URL into R2 so it lives in our
 * bucket (predictable URL, immune to upstream link rot, served from our
 * CDN).
 *
 * The fetch is DNS-rebinding-pinned via `resolveAndPinSafeUrl` — the
 * supplied URL is resolved once, every resolved address validated against
 * the SSRF blocklist, and undici's connect callback locked to that
 * address set. The actual fetch can't be redirected to a private IP via
 * rebinding.
 *
 * Authed. Rate-limited (URL imports are network-heavy compared to the
 * presigned-PUT path; 20 per minute is enough for bulk-row imports
 * without enabling abuse).
 */
export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
      { status: 503 },
    );
  }
  const { limited } = checkRateLimit(`upload-url:${getClientIP(req)}`, 20, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: { imageUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const imageUrl = body.imageUrl?.trim();
  if (!imageUrl) {
    return NextResponse.json({ error: 'imageUrl is required' }, { status: 400 });
  }

  let imgRes: Response;
  try {
    const { url: safeUrl, dispatcher } = await resolveAndPinSafeUrl(imageUrl, {
      allowedProtocols: ['https:'],
    });
    imgRes = await fetch(safeUrl, { dispatcher } as RequestInit & { dispatcher: unknown });
  } catch (err) {
    logger.warn('Image URL import rejected', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Image URL could not be fetched safely' }, { status: 400 });
  }
  if (!imgRes.ok) {
    return NextResponse.json(
      { error: `Source URL responded ${imgRes.status}` },
      { status: 502 },
    );
  }

  const contentType = (imgRes.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return NextResponse.json(
      { error: `Unsupported image type: ${contentType || 'unknown'}` },
      { status: 400 },
    );
  }
  const contentLength = Number(imgRes.headers.get('content-length') ?? 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Image too large (max 12 MB)' }, { status: 413 });
  }
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Image too large (max 12 MB)' }, { status: 413 });
  }

  const ext = contentType === 'image/png' ? 'png'
    : contentType === 'image/webp' ? 'webp'
    : contentType === 'image/gif' ? 'gif'
    : 'jpg';
  const r2Key = buildUserUploadKey(`url-import-${Math.random().toString(36).slice(2, 10)}.${ext}`);
  const bucket = getImagesBucket();
  try {
    await uploadToBucket(bucket, r2Key, buffer, contentType);
  } catch (err) {
    logger.error('Image URL import — R2 upload failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Failed to mirror image to storage' }, { status: 502 });
  }
  const downloadUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
  return NextResponse.json({ imageUrl: downloadUrl, r2Key }, { status: 201 });
});

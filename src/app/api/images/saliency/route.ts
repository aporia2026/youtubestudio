import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { computeImageSaliency } from '@/lib/image-saliency';
import { resolveAndPinSafeUrl } from '@/lib/url-safety';
import { logger } from '@/lib/logger';

export const maxDuration = 60;

/**
 * Compute the pixel-saliency map of an image URL.
 *
 * Used by the production-doc image cell after upload / URL import so
 * overlays land on empty pixels instead of focal content — the same
 * smarts that text-to-image generations already get from
 * `/api/generate/production-doc/image`.
 *
 * The endpoint is intentionally a pure CPU job: takes a URL, returns
 * an `ImageSaliencyMap`. No DB writes — the caller persists the map
 * onto the row's state. Failure surfaces a 200 with `saliency: null`
 * so the cell stays usable; the renderer already has a fallback path
 * (LLM-planned overlay zone).
 *
 * Authed. Rate limit: 60 per 60s per IP (saliency is cheap; this
 * matches the bulk-generate burst rate we already permit on the
 * image-generate route).
 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  const { limited } = checkRateLimit(`saliency:${getClientIP(req)}`, 60, 60_000);
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
    logger.warn('Saliency image fetch rejected', {
      detail: err instanceof Error ? err.message : String(err),
    });
    // 400 on validation/SSRF failure so the caller can tell user input is bad
    return NextResponse.json({ error: 'Image URL could not be fetched safely' }, { status: 400 });
  }
  if (!imgRes.ok) {
    return NextResponse.json({ saliency: null, reason: `Upstream ${imgRes.status}` });
  }

  const contentLength = Number(imgRes.headers.get('content-length') ?? 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Image too large for saliency analysis' }, { status: 413 });
  }
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Image too large for saliency analysis' }, { status: 413 });
  }

  const saliency = await computeImageSaliency(buffer);
  return NextResponse.json({ saliency });
});

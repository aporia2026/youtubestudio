import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { removeGridBackground } from '@/lib/grid-bg-removal';
import { checkSafePublicUrl } from '@/lib/url-safety';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';
import { recordIntent, markDelivered, markFailed } from '@/lib/provider-generations';

export const maxDuration = 60;

/**
 * Remove background from a topic-card-grid card's uploaded image. The
 * editor calls this when the user picks `fillStyle === 'cutout'` on a
 * card whose `sourceImageUrl` doesn't already have an alpha channel.
 * The returned `cutoutUrl` is stored on the card and reused on every
 * subsequent render — toggling `fillStyle` back to `photo` and then
 * back to `cutout` is free after the first call.
 *
 * Flow (mirrors `/api/generate/production-doc/image/rmbg`):
 *   1. Auth + rate-limit (20/min/IP).
 *   2. SSRF guard the source URL.
 *   3. Pipe the image through `851-labs/background-remover` (`removeGridBackground`
 *      in `src/lib/grid-bg-removal.ts`). ~$0.00044/image, ~2 s on T4 GPU.
 *   4. Mirror the alpha PNG cutout to R2 and return the public URL.
 *
 * Plan: `_plans/2026-06-04-topic-card-grid-circle-parity.md`.
 */

interface GridRmbgRequestBody {
  /** Source image URL for the card (the card's `sourceImageUrl`).
   *  Must be HTTPS and pass the SSRF safety check. */
  sourceImageUrl?: string;
  /** Optional card index for logging — purely diagnostic, not used by
   *  the call itself. */
  cardIndex?: number;
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited } = checkRateLimit(`grid-rmbg:${getClientIP(req)}`, 20, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: GridRmbgRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { sourceImageUrl, cardIndex } = body;
  if (!sourceImageUrl?.trim()) {
    return NextResponse.json({ error: 'sourceImageUrl required' }, { status: 400 });
  }

  const sourceCheck = checkSafePublicUrl(sourceImageUrl, { allowedProtocols: ['https:'] });
  if (!sourceCheck.ok) {
    return NextResponse.json({ error: `Source image: ${sourceCheck.error}` }, { status: 400 });
  }

  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (!replicateToken) {
    return NextResponse.json(
      { error: 'REPLICATE_API_TOKEN is not configured' },
      { status: 500 },
    );
  }

  console.info('[grid-rmbg request]', {
    cardIndex: cardIndex ?? null,
    sourceHost: (() => {
      try {
        return new URL(sourceImageUrl).hostname;
      } catch {
        return '(unparseable)';
      }
    })(),
  });

  // Audit BEFORE the paid Replicate call so we never lose a charge to
  // an untraceable run if Postgres can't accept the row.
  const intent = await recordIntent({
    userId: session.uid,
    workspaceId: session.ws,
    route: '/api/thumbnails/grid-rmbg',
    provider: 'replicate',
    providerModel: '851-labs/background-remover',
  });

  try {
    const startedAt = Date.now();
    const cutoutBuffer = await removeGridBackground({
      imageUrl: sourceImageUrl,
      replicateToken,
    });
    const durationMs = Date.now() - startedAt;

    // Mirror to R2 so the doc carries a stable URL (Replicate output URLs
    // expire). Random suffix so two concurrent calls don't collide on key.
    const randomSuffix = Math.random().toString(36).slice(2, 10);
    const bucket = getImagesBucket();
    const r2Key = `thumbnails/grid-rmbg/${Date.now()}-${randomSuffix}.png`;
    await uploadToBucket(bucket, r2Key, cutoutBuffer, 'image/png');
    const cutoutUrl = await getDownloadUrlForBucket(
      bucket,
      r2Key,
      process.env.R2_IMAGES_PUBLIC_URL,
    );
    void markDelivered({
      id: intent.id,
      providerRequestId: null,
      responseUrl: cutoutUrl,
      costUsd: 0.00044,
      durationMs,
    });
    console.info('[grid-rmbg mirror]', {
      cardIndex: cardIndex ?? null,
      r2Key,
      ok: true,
      durationMs,
      bytes: cutoutBuffer.length,
    });
    return NextResponse.json({ cutoutUrl });
  } catch (err) {
    void markFailed({
      id: intent.id,
      failureReason: err instanceof Error ? err.message : String(err),
    });
    logger.error('Grid RMBG failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Background removal failed' },
      { status: 500 },
    );
  }
});

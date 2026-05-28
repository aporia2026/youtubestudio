import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { removeBackground } from '@/lib/overlay-rmbg';
import { checkSafePublicUrl } from '@/lib/url-safety';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';
import { recordIntent, markDelivered, markFailed } from '@/lib/provider-generations';

export const maxDuration = 60;

/**
 * Remove background from a production-doc row's image. Phase 5 of
 * `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md`.
 *
 * Flow:
 *   1. Auth + rate-limit (20/min/IP — same envelope as the edit
 *      route since the operation is similarly expensive).
 *   2. SSRF guard the source URL.
 *   3. Pipe the image through Bria RMBG-2.0 (`removeBackground` in
 *      `src/lib/overlay-rmbg.ts`, already used by the overlay
 *      auto-fetch pipeline and the Phase 5 overlay edit route).
 *   4. Mirror the alpha PNG cutout to R2 and return the public URL.
 *
 * The caller (editor) stores the returned URL in the row's
 * `image_rmbg_url` and flips `image_rmbg_applied` to true via a
 * PATCH_ROW command. Toggling the flag back to false (right-click →
 * Restore original background) reverts WITHOUT calling this route
 * again — the cutout stays in the row so re-applying is free.
 *
 * Authed. Rate-limited at 20/min/IP. Source URL SSRF-checked
 * before any external fetch.
 */

interface RmbgRequestBody {
  /** Source image URL (the row's current `image_url`). Must be
   *  HTTPS and pass the SSRF safety check. */
  originalImageUrl?: string;
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited } = checkRateLimit(`prodoc-img-rmbg:${getClientIP(req)}`, 20, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: RmbgRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { originalImageUrl } = body;
  if (!originalImageUrl?.trim()) {
    return NextResponse.json({ error: 'originalImageUrl required' }, { status: 400 });
  }

  const sourceCheck = checkSafePublicUrl(originalImageUrl, { allowedProtocols: ['https:'] });
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

  console.info('[image-rmbg request]', {
    sourceHost: (() => {
      try {
        return new URL(originalImageUrl).hostname;
      } catch {
        return '(unparseable)';
      }
    })(),
  });

  // Audit-row BEFORE the paid Replicate call (Phase 1.0 of
  // _plans/2026-05-29-persistence-rebuild.md). Throws to short-circuit
  // if Postgres can't accept the row — better a transient 500 than an
  // untraceable Bria charge on a route whose client today is the editor
  // PATCH_ROW handler with no retry.
  const intent = await recordIntent({
    userId: session.uid,
    workspaceId: session.ws,
    route: '/api/generate/production-doc/image/rmbg',
    provider: 'replicate',
    providerModel: 'bria/rmbg-2.0',
  });

  try {
    const startedAt = Date.now();
    const cutoutBuffer = await removeBackground({
      imageUrl: originalImageUrl,
      replicateToken,
    });
    const durationMs = Date.now() - startedAt;

    // Mirror to R2 so the doc carries a stable URL (Replicate output
    // URLs expire). Mirrors the pattern the edit route uses.
    const randomSuffix = Math.random().toString(36).slice(2, 10);
    const bucket = getImagesBucket();
    const r2Key = `prodoc-images/${Date.now()}-rmbg-${randomSuffix}.png`;
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
      costUsd: null,
      durationMs,
    });
    console.info('[image-rmbg mirror]', {
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
    logger.error('Production-doc image RMBG failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Background removal failed' },
      { status: 500 },
    );
  }
});

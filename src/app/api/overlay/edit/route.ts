import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  createGpt4oImageTask,
  createKieTask,
  pollGpt4oImageResult,
  pollKieResult,
} from '@/lib/kie-poll';
import { checkSafePublicUrl } from '@/lib/url-safety';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';

export const maxDuration = 300;

/**
 * Edit an overlay image (transparent PNG that gets composited on top of a
 * scene). Phase 5 of `_plans/2026-05-18-overlay-system-overhaul.md`.
 *
 * Two tiers, matching the row-image edit route's shape:
 *
 *   1. Smart edit  (`mode: 'smart'`)  — Nano Banana 2 via Kie's
 *      `google/nano-banana-edit`. Prompt + source only; the model
 *      segments the region the prompt describes. ~$0.034 batch /
 *      ~$0.067 real-time. Default mode.
 *
 *   2. Brush mask  (`mode: 'brush'`)  — GPT-4o image via Kie's
 *      `gpt4o-image/generate`. Mask + prompt + quality tier. Mask is
 *      a black/white PNG matching source dimensions: black = regenerate,
 *      white = preserve. ~$0.034 medium / ~$0.133 high.
 *
 * Differs from the row-image edit route in three ways:
 *
 *   - R2 prefix is `overlays/edit-` (the source's `overlays/<ws>/...`
 *     cache key is content-addressed, so an edit MUST land at a
 *     different key or the next normal-mode fetch would overwrite the
 *     edit on a cache rebuild).
 *   - Output aspect ratio is probed from the source via sharp (logos
 *     range from 1:8 portrait stamps to 5:1 wordmarks; a fixed 16:9
 *     would distort most of them).
 *   - No saliency computation — overlays are placed ON scenes, not the
 *     reverse, so the overlay's own saliency doesn't matter.
 *
 * Auto-RMBG after edit is intentionally NOT wired in v1: Nano Banana
 * preserves transparency when prompted, and GPT-4o's brush mask leaves
 * unmasked transparent pixels alone. If quality regresses in practice,
 * Phase 5.1 can wire the Phase 4 gate on the edited output.
 *
 * Authed. Rate-limited at 20/min/IP — matches the row-image edit cap.
 */

const ALLOWED_MODES = ['smart', 'brush'] as const;
type EditMode = (typeof ALLOWED_MODES)[number];

interface EditRequestBody {
  overlayUrl?: string;
  prompt?: string;
  mode?: string;
  mask?: { url?: string; quality?: 'low' | 'medium' | 'high' };
}

/** Map an aspect ratio number → the Kie `image_size` literal that's
 *  closest. Logos run the full gamut (1:8 portraits to 5:1 wordmarks),
 *  so we pick the nearest of the supported buckets rather than forcing
 *  16:9 like the row-image route. Hot-path is cheap enough to inline. */
function aspectToKieSize(
  aspect: number,
): '16:9' | '4:3' | '1:1' | '3:4' | '9:16' {
  if (aspect >= 1.7) return '16:9';
  if (aspect >= 1.2) return '4:3';
  if (aspect >= 0.85) return '1:1';
  if (aspect >= 0.6) return '3:4';
  return '9:16';
}

/** Probe the source image's dimensions via sharp — needed for two
 *  reasons: (1) picking the Kie aspect bucket, (2) GPT-4o requires the
 *  mask to be EXACT pixel-match with the source, which the brush editor
 *  already enforces but the route validates anyway. Returns null on
 *  any failure (network, decode) — callers default to 1:1. */
async function probeAspect(url: string): Promise<{ aspect: number; width: number; height: number } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w <= 0 || h <= 0) return null;
    return { aspect: w / h, width: w, height: h };
  } catch (err) {
    logger.warn('[overlay edit] aspect probe failed', {
      url,
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited } = checkRateLimit(`overlay-edit:${getClientIP(req)}`, 20, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: EditRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { overlayUrl, prompt } = body;
  const mode = (body.mode || 'smart') as EditMode;
  if (!ALLOWED_MODES.includes(mode)) {
    return NextResponse.json(
      { error: `Unknown mode: ${mode}. Valid: ${ALLOWED_MODES.join(', ')}` },
      { status: 400 },
    );
  }
  if (!overlayUrl?.trim() || !prompt?.trim()) {
    return NextResponse.json({ error: 'overlayUrl + prompt required' }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return NextResponse.json({ error: 'Prompt too long (max 2000 chars)' }, { status: 400 });
  }

  // SSRF guard on both URLs. Kie's gateway fetches from their infra,
  // but we still fail fast on private-network URLs so we don't bill
  // for a doomed task.
  const overlayCheck = checkSafePublicUrl(overlayUrl, { allowedProtocols: ['https:'] });
  if (!overlayCheck.ok) {
    return NextResponse.json({ error: `overlayUrl: ${overlayCheck.error}` }, { status: 400 });
  }

  let maskUrl: string | undefined;
  let maskQuality: 'low' | 'medium' | 'high' = 'medium';
  if (mode === 'brush') {
    if (!body.mask?.url) {
      return NextResponse.json({ error: 'mask.url required for brush mode' }, { status: 400 });
    }
    const maskCheck = checkSafePublicUrl(body.mask.url, { allowedProtocols: ['https:'] });
    if (!maskCheck.ok) {
      return NextResponse.json({ error: `mask URL: ${maskCheck.error}` }, { status: 400 });
    }
    maskUrl = body.mask.url;
    if (body.mask.quality === 'low' || body.mask.quality === 'medium' || body.mask.quality === 'high') {
      maskQuality = body.mask.quality;
    }
  }

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 });
  }

  // Aspect probe — used for the Kie size param. Failure falls back
  // to 1:1, which is the safest neutral default.
  const aspectInfo = await probeAspect(overlayUrl);
  const kieSize = aspectInfo ? aspectToKieSize(aspectInfo.aspect) : '1:1';
  logger.info('[overlay edit] start', {
    workspace: session.ws,
    mode,
    kieSize,
    aspect: aspectInfo?.aspect ?? null,
    promptLength: prompt.length,
  });

  try {
    let resultUrl: string;
    if (mode === 'smart') {
      const taskId = await createKieTask(apiKey, 'google/nano-banana-edit', {
        prompt: prompt.trim(),
        image_urls: [overlayUrl],
        image_size: kieSize,
        output_format: 'png',
      });
      resultUrl = await pollKieResult(taskId, apiKey);
    } else {
      // GPT-4o image edit only accepts 1:1 / 3:2 / 2:3 per Kie docs.
      // Map the overlay's native aspect to the closest of those — a
      // wide wordmark falls back to 3:2 (not 16:9 like the row-image
      // route, which is closer for a 5:1 wordmark than a square).
      const gptSize: '1:1' | '3:2' | '2:3' = aspectInfo
        ? aspectInfo.aspect >= 1.2
          ? '3:2'
          : aspectInfo.aspect <= 0.8
            ? '2:3'
            : '1:1'
        : '1:1';
      const taskId = await createGpt4oImageTask(apiKey, {
        prompt: prompt.trim(),
        filesUrl: [overlayUrl],
        maskUrl,
        size: gptSize,
        quality: maskQuality,
      });
      resultUrl = await pollGpt4oImageResult(taskId, apiKey);
    }

    // Mirror the result to R2 under `overlays/edit-…` so the source
    // cache key (`overlays/<ws>/<hash>.png`) is preserved — a future
    // re-fetch of the same stock_terms still hits its own cache.
    let finalUrl = resultUrl;
    try {
      const imgRes = await fetch(resultUrl);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const ext = contentType.includes('png') ? 'png' : 'jpg';
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `overlays/edit-${session.ws}-${Date.now()}-${randomSuffix}.${ext}`;
        await uploadToBucket(bucket, r2Key, buffer, contentType);
        finalUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      } else {
        logger.warn('[overlay edit] result fetch non-OK — falling back to Kie URL', {
          status: imgRes.status,
        });
      }
    } catch (mirrorErr) {
      logger.warn('[overlay edit] R2 mirror failed — falling back to Kie URL', {
        detail: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
      });
    }

    logger.info('[overlay edit] done', {
      workspace: session.ws,
      mode,
      finalUrl,
    });
    return NextResponse.json({ overlayUrl: finalUrl, mode });
  } catch (err) {
    logger.error('Overlay edit failed', {
      detail: err instanceof Error ? err.message : String(err),
      mode,
      promptLength: prompt.length,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Edit failed' },
      { status: 500 },
    );
  }
});

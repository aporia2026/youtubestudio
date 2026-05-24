import { NextRequest, NextResponse } from 'next/server';
import { COLLAGE_TESTER_ENABLED } from '@/lib/feature-flags';
import { logger } from '@/lib/logger';
import {
  buildKieImageInput,
  getImageModelSpec,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
} from '@/lib/image-models';
import { createKieTask, pollKieResult } from '@/lib/kie-poll';
import { upscaleViaRecraft } from '@/lib/upscale';
import { sliceCollage } from '@/lib/collage-slicer';
import { detectMalformedCollage } from '@/lib/collage-detect';
import { composeCollagePrompt } from '@/lib/collage-prompt';
import { apiRoute } from '@/lib/route-helpers';

export const maxDuration = 300;

/**
 * Dev-only collage tester endpoint. Returns the URL at each pipeline
 * stage (raw 1K collage, upscaled collage, 4 cropped quadrants) plus
 * the detection diagnostics, so the debug panel in the production-doc
 * page can render them all for visual inspection.
 *
 * Gated by `COLLAGE_TESTER_ENABLED` server-side. Returns 404 (not 401)
 * when off — the endpoint should not be discoverable in production.
 *
 * Differs from the main collage route in three ways:
 *   1. Returns all 3 intermediate URLs, not just the final 4 quadrants.
 *   2. No retry loop — the tester wants to see what the model actually
 *      produced on the first attempt.
 *   3. No fallback — malformed results are reported as-is so the user
 *      can see the failure mode.
 *
 * Authenticated (no point letting unauthenticated callers burn the
 * KIE_API_KEY budget) and rate-limited via the same key shape as the
 * real generation routes.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  if (!COLLAGE_TESTER_ENABLED) {
    // 404 instead of 403 — the tester should look like it doesn't exist
    // when the flag is off.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: { prompts?: string[]; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const prompts = body.prompts;
  if (!Array.isArray(prompts) || prompts.length !== 4) {
    return NextResponse.json(
      { error: '`prompts` must be an array of exactly 4 strings' },
      { status: 400 },
    );
  }
  const trimmed = prompts.map((p) => (typeof p === 'string' ? p.trim() : ''));
  if (trimmed.some((p) => p.length === 0)) {
    return NextResponse.json(
      { error: 'Every prompt must be a non-empty string' },
      { status: 400 },
    );
  }
  if (trimmed.some((p) => p.length > 400)) {
    return NextResponse.json(
      { error: 'Each prompt must be at most 400 characters' },
      { status: 400 },
    );
  }

  const modelValue = body.model?.trim() || DEFAULT_IMAGE_MODEL;
  const spec = getImageModelSpec(modelValue);
  if (!spec || spec.provider !== 'kie' || !spec.kieModel) {
    return NextResponse.json(
      { error: `Model '${modelValue}' is not a Kie cloud model. Valid: ${IMAGE_MODELS.filter((m) => m.provider === 'kie').map((m) => m.value).join(', ')}` },
      { status: 400 },
    );
  }

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 });
  }

  // Hash the prompts for the log — full prompts can contain user
  // secrets and we'd rather not stream them through the log drain.
  const promptsHash = simpleHash(trimmed.join('|'));
  logger.info('[collage tester] run', {
    user: session.uid,
    model: spec.value,
    prompts_hash: promptsHash,
  });

  try {
    // Stage 1 — generate raw 1K collage
    const t0 = Date.now();
    const composedPrompt = composeCollagePrompt(trimmed, false);
    const taskId = await createKieTask(
      apiKey,
      spec.kieModel,
      buildKieImageInput(spec.value, composedPrompt),
    );
    const rawCollageUrl = await pollKieResult(taskId, apiKey);
    const rawMs = Date.now() - t0;

    // Stage 2 — upscale via Recraft
    const t1 = Date.now();
    const upscaleResult = await upscaleViaRecraft(rawCollageUrl);
    const upscaledUrl = upscaleResult.url;
    const upscaleMs = Date.now() - t1;

    // Detection runs on the upscaled bytes (mirrors the production
    // collage route). Tester wants to see the diagnostics regardless
    // of whether they passed.
    let detection = null;
    try {
      const detRes = await fetch(upscaledUrl);
      if (detRes.ok) {
        const buf = Buffer.from(await detRes.arrayBuffer());
        detection = await detectMalformedCollage(buf);
      }
    } catch (err) {
      logger.warn('[collage tester] detection failed', {
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Stage 3 — slice into 4 quadrants
    const t2 = Date.now();
    const slice = await sliceCollage(upscaledUrl, { r2KeyPrefix: 'collage-tester' });
    const sliceMs = Date.now() - t2;

    return NextResponse.json({
      status: 'success',
      stages: {
        rawCollageUrl,
        upscaledCollageUrl: upscaledUrl,
        quadrantUrls: slice.quadrantUrls,
      },
      diagnostics: {
        rawMs,
        upscaleMs,
        upscaleReason: upscaleResult.reason,
        upscaleAttempts: upscaleResult.attempts,
        sourceLongEdgePx: upscaleResult.sourceLongEdgePx,
        sliceMs,
        sourceWidth: slice.sourceWidth,
        sourceHeight: slice.sourceHeight,
        quadrantWidth: slice.quadrantWidth,
        quadrantHeight: slice.quadrantHeight,
        detection,
      },
    });
  } catch (err) {
    logger.error('[collage tester] pipeline failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Collage tester failed' },
      { status: 500 },
    );
  }
});

/** Cheap non-crypto hash for log identity. Not for security — just
 *  enough to spot duplicate runs in the log drain without leaking
 *  prompt text. */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

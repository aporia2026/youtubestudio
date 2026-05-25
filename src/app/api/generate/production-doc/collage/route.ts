import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  buildKieImageInput,
  getImageModelSpec,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
} from '@/lib/image-models';
import { createKieTask, pollKieResultThenUpscale } from '@/lib/kie-poll';
import { generateAtlasT2I } from '@/lib/atlas-cloud-images';
import { cropTo16x9AndUpload } from '@/lib/image-gen-dispatch';
import { upscaleViaRecraft } from '@/lib/upscale';
import { computeImageSaliency } from '@/lib/image-saliency';
import type { ImageSaliencyMap } from '@/remotion/utils';
import { sliceCollage } from '@/lib/collage-slicer';
import { detectMalformedCollage } from '@/lib/collage-detect';
import { composeCollagePrompt } from '@/lib/collage-prompt';
import { apiRoute } from '@/lib/route-helpers';

export const maxDuration = 300;

/**
 * 2×2 collage batch image generation. Saves ~70–75% on per-shot kie
 * cost vs. 4 separate single-shot calls (one collage call + one
 * upscale call vs. four of each).
 *
 * Pipeline:
 *   1. Compose the 4 caller prompts into a 2×2 prompt template asking
 *      the model for 4 distinct 16:9 scenes separated by a thin
 *      neutral border.
 *   2. Create the kie task with the chosen image model. Auto-upscale
 *      via Recraft Crisp Upscale (~4×) runs inside the poller.
 *   3. Fetch the upscaled bytes once. Run histogram + Sobel detection
 *      to catch malformed (blank / collapsed) quadrants. If any
 *      quadrant fails: retry the generation once with a stronger
 *      prompt suffix. If the retry also fails: respond with
 *      `status: 'fallback_needed'` so the client falls back to 4
 *      single-shot calls.
 *   4. Slice the upscaled collage into 4 quadrants, upload each to R2,
 *      compute saliency for each. Return the 4 URLs + saliency in shot
 *      order.
 *
 * Eligibility (client-enforced — this route doesn't second-guess):
 *   - All 4 shots must use the same image model (collage model = single
 *     model call). Mixed-model groups break out as single shots.
 *   - All 4 must be t2i (no per-shot style refs). i2i is single-shot.
 *   - This route doesn't apply the OST/safe-top/section-title
 *     augmentation that /image does — the cell-prompts are sent
 *     verbatim. Caller is responsible for any per-cell augmentation
 *     (or for not enabling collage on shots that need it).
 *
 * Rate limits mirror the single-shot route at the same key shape, so
 * one route taking ~75% of the spend can't sneak past the limiter.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  try {
    const ipLimit = checkRateLimit(`prodoc-img:${getClientIP(req)}`, 30, 60_000);
    if (ipLimit.limited) return NextResponse.json({ error: 'Rate limited (IP)' }, { status: 429 });
    const userLimit = checkRateLimit(`prodoc-img-uid:${session.uid}`, 30, 60_000);
    if (userLimit.limited) {
      return NextResponse.json(
        { error: 'Rate limited (account) — slow down on image generation' },
        { status: 429 },
      );
    }

    let body: {
      prompts?: string[];
      model?: string;
    };
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
    // Per-cell cap. The composed collage prompt adds ~250 chars of
    // template overhead on top of the 4 cell prompts. Keep each cell at
    // most 400 chars so the total stays under the 2000-char budget the
    // single-shot route uses.
    if (trimmed.some((p) => p.length > 400)) {
      return NextResponse.json(
        { error: 'Each prompt must be at most 400 characters' },
        { status: 400 },
      );
    }

    const modelValue = body.model?.trim() || DEFAULT_IMAGE_MODEL;
    const spec = getImageModelSpec(modelValue);
    if (!spec) {
      return NextResponse.json(
        { error: `Unknown image model: ${modelValue}. Valid: ${IMAGE_MODELS.map((m) => m.value).join(', ')}` },
        { status: 400 },
      );
    }
    // Atlas Cloud joined the collage path on 2026-05-25 — same OpenAI
    // GPT Image 2 model the Kie variant hits, cheaper invoice. See
    // _plans/2026-05-25-atlas-cloud-gpt-image-2.md (Phase 4). Local
    // ComfyUI stays excluded for the same reason as before: no upscale
    // path on the local generator means quadrants would land at
    // ~540×360 after slicing, unusable for the production-doc shots.
    if (spec.provider !== 'kie' && spec.provider !== 'atlas') {
      return NextResponse.json(
        { error: `Collage mode is cloud-only. Model '${modelValue}' is not a Kie or Atlas cloud model.` },
        { status: 400 },
      );
    }
    if (spec.provider === 'kie' && !spec.kieModel) {
      return NextResponse.json(
        { error: `Kie model '${modelValue}' is missing its kieModel mapping.` },
        { status: 500 },
      );
    }
    if (spec.provider === 'atlas' && !spec.atlasModel) {
      return NextResponse.json(
        { error: `Atlas model '${modelValue}' is missing its atlasModel mapping.` },
        { status: 500 },
      );
    }

    // KIE_API_KEY only required when the chosen model dispatches through
    // Kie. Atlas-only collage runs against ATLAS_CLOUD_API_KEY (checked
    // inside generateAtlasT2I); a missing key surfaces as a clean
    // "[atlas-images]" error from the helper.
    const apiKey = process.env.KIE_API_KEY;
    if (spec.provider === 'kie' && !apiKey) {
      return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 });
    }

    // ─── Try → detect malformed → retry once → fallback ────────────────
    let attemptCount = 0;
    let upscaledUrl: string | null = null;
    let upscaledBuf: Buffer | null = null;
    let malformedIndices: number[] = [];
    let lastError = '';

    for (let attempt = 1; attempt <= 2; attempt++) {
      attemptCount = attempt;
      const composedPrompt = composeCollagePrompt(trimmed, attempt === 2);
      const t0 = Date.now();
      try {
        logger.info('[collage generate] start', {
          attempt,
          model: spec.value,
          provider: spec.provider,
          vendor_model: spec.provider === 'atlas' ? spec.atlasModel : spec.kieModel,
          prompt_chars: composedPrompt.length,
        });
        let url: string;
        if (spec.provider === 'atlas') {
          // Atlas: generate (1536×1024 = 3:2) → 16:9 center-crop
          // (1536×864) → Recraft 4× upscale. The 1536×864 collage
          // composes naturally to 4 quadrants of 768×432 → ~3K per
          // quadrant after upscale, on par with the Kie path's
          // post-upscale per-cell resolution.
          const atlasResult = await generateAtlasT2I({
            prompt: composedPrompt,
            size: spec.atlasSize ?? '1536x1024',
            quality: spec.atlasQuality ?? 'medium',
          });
          logger.info('[collage atlas-generate] vendor done', {
            attempt,
            prediction_id: atlasResult.predictionId,
            predict_ms: atlasResult.predictTimeMs,
          });
          const croppedUrl = await cropTo16x9AndUpload(atlasResult.url, 'prodoc-images-atlas-crop');
          const upscaleResult = await upscaleViaRecraft(croppedUrl);
          url = upscaleResult.url;
        } else {
          const taskId = await createKieTask(
            apiKey!,
            spec.kieModel!,
            buildKieImageInput(spec.value, composedPrompt),
          );
          url = await pollKieResultThenUpscale(taskId, apiKey!);
        }
        const fetchRes = await fetch(url);
        if (!fetchRes.ok) {
          throw new Error(`Failed to fetch generated collage: HTTP ${fetchRes.status}`);
        }
        const buf = Buffer.from(await fetchRes.arrayBuffer());

        const detection = await detectMalformedCollage(buf);
        logger.info('[collage generate] success', {
          attempt,
          all_valid: detection.allValid,
          malformed_indices: detection.malformedIndices,
          generate_ms: Date.now() - t0,
        });

        if (detection.allValid) {
          upscaledUrl = url;
          upscaledBuf = buf;
          malformedIndices = [];
          break; // success — out of retry loop
        }

        malformedIndices = detection.malformedIndices;
        if (attempt === 2) {
          // Already retried, still malformed. Tell the client to fall back.
          logger.warn('[collage generate] malformed after retry', {
            malformed_indices: malformedIndices,
          });
          return NextResponse.json({
            status: 'fallback_needed',
            reason: 'malformed_after_retry',
            detail: `Quadrants ${malformedIndices.join(', ')} failed detection on both attempts.`,
            malformedIndices,
          });
        }
        logger.info('[collage generate] malformed retry', {
          malformed_indices: malformedIndices,
        });
        // Loop to next attempt with the stronger prompt.
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn('[collage generate] attempt threw', {
          attempt,
          generate_ms: Date.now() - t0,
          error: lastError.slice(0, 200),
        });
        if (attempt === 2) {
          // Two attempts failed at the generation layer. Tell the client
          // to fall back — better to do 4 single-shot calls than to fail
          // the whole batch.
          return NextResponse.json({
            status: 'fallback_needed',
            reason: 'generation_error',
            detail: lastError.slice(0, 300),
          });
        }
      }
    }

    // Guard for the type-narrowing — if we exited the loop without
    // setting these, we returned a fallback response above.
    if (!upscaledUrl || !upscaledBuf) {
      return NextResponse.json(
        { status: 'fallback_needed', reason: 'generation_error', detail: 'unexpected null after retry loop' },
        { status: 500 },
      );
    }

    // ─── Slice into 4 quadrants + upload to R2 ─────────────────────────
    let sliceResult;
    try {
      sliceResult = await sliceCollage(upscaledUrl);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error('[collage slice] failed — falling back', { detail });
      return NextResponse.json({
        status: 'fallback_needed',
        reason: 'generation_error',
        detail: `Slicing failed: ${detail.slice(0, 200)}`,
      });
    }

    // ─── Compute saliency per quadrant from the in-memory bytes ────────
    // Re-extract each quadrant from `upscaledBuf` so saliency runs on
    // the same pixels the slicer extracted. Failure non-blocking —
    // the overlay placement resolver falls back to the LLM-planned
    // zone when saliency is null.
    const saliencies: (ImageSaliencyMap | null)[] = await Promise.all(
      sliceResult.quadrantUrls.map(async (url): Promise<ImageSaliencyMap | null> => {
        try {
          const res = await fetch(url);
          if (!res.ok) return null;
          const quadrantBytes = Buffer.from(await res.arrayBuffer());
          return await computeImageSaliency(quadrantBytes);
        } catch {
          return null;
        }
      }),
    );

    return NextResponse.json({
      status: 'success',
      imageUrls: sliceResult.quadrantUrls,
      saliencies,
      diagnostics: {
        attempts: attemptCount,
        retried: attemptCount > 1,
        malformedIndices,
        sourceWidth: sliceResult.sourceWidth,
        sourceHeight: sliceResult.sourceHeight,
        quadrantWidth: sliceResult.quadrantWidth,
        quadrantHeight: sliceResult.quadrantHeight,
        sliceMs: sliceResult.totalMs,
      },
    });
  } catch (err: unknown) {
    logger.error('Collage image generation error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Collage generation failed' },
      { status: 500 },
    );
  }
});


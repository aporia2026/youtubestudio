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
import { generateAtlasT2I, generateAtlasI2I } from '@/lib/atlas-cloud-images';
import { cropTo16x9AndUpload } from '@/lib/image-gen-dispatch';
import { upscaleViaRecraft } from '@/lib/upscale';
import { computeImageSaliency } from '@/lib/image-saliency';
import type { ImageSaliencyMap } from '@/remotion/utils';
import { sliceCollage } from '@/lib/collage-slicer';
import { detectMalformedCollage } from '@/lib/collage-detect';
import { composeCollagePrompt } from '@/lib/collage-prompt';
import { augmentCellPrompt, COLLAGE_CELL_PROMPT_CAP } from '@/lib/prompt-augmentation';
import { apiRoute } from '@/lib/route-helpers';
import { recordIntent, markDelivered, markFailed } from '@/lib/provider-generations';
import { resolveStyle } from '@/lib/production-doc-styles';
import {
  loadStyleReferences,
  mirrorPublicUrlRefToR2,
} from '@/lib/production-doc-styles-refs';
import { getDownloadUrlForBucket } from '@/lib/r2';

export const maxDuration = 300;

/**
 * 2×2 collage batch image generation. Saves ~70–75% on per-shot kie
 * cost vs. 4 separate single-shot calls (one collage call + one
 * upscale call vs. four of each).
 *
 * Pipeline:
 *   1. Augment each of the 4 caller cells per-cell (OST baking,
 *      safe-top bias, sheet-description hint) via the shared helper.
 *      Then compose into a 2×2 prompt template asking the model for 4
 *      distinct 16:9 scenes separated by a thin neutral border.
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
 * Request body shape:
 *   - Preferred: `cells: Array<{ prompt, onScreenText?, onScreenTextMode?,
 *     sectionTitle?, sectionTitleLayout?, styleSheetDescription? }>` — 4
 *     entries. Each cell goes through `augmentCellPrompt` before
 *     composition so the per-cell prompt that reaches the model is
 *     byte-identical to what `/image` would have sent for the same
 *     cell.
 *   - Legacy: `prompts: string[]` — 4 entries, sent verbatim with no
 *     augmentation. Preserved for the dev tester endpoint and any
 *     caller that hasn't migrated yet. The production callers all
 *     send `cells`.
 *
 * Eligibility (client-enforced — this route doesn't second-guess):
 *   - All 4 shots must use the same image model (collage model = single
 *     model call). Mixed-model groups break out as single shots.
 *   - All 4 must be t2i (no per-shot style refs). i2i is single-shot.
 *
 * Rate limits mirror the single-shot route at the same key shape, so
 * one route taking ~75% of the spend can't sneak past the limiter.
 */
interface CollageCellInput {
  prompt: string;
  onScreenText?: string;
  onScreenTextMode?: 'bake' | 'overlay' | 'none';
  sectionTitle?: string;
  sectionTitleLayout?: 'overlay' | 'letterbox';
  styleSheetDescription?: string;
}
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Each retry attempt is a separate paid call, so this gets re-set
  // inside the loop. Cleared after the per-attempt terminal status
  // lands (markDelivered or markFailed). The outer catch uses it to
  // mark a row failed when an unexpected error blows past the loop.
  // See Phase 1.0 of _plans/2026-05-29-persistence-rebuild.md.
  let pendingIntentId: string | null = null;

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
      cells?: CollageCellInput[];
      model?: string;
      /** 2026-05-31 (plan §C) — style preset forwarded from the page so
       *  the route can load the style's refs server-side and route Atlas
       *  generation through i2i. When omitted, the route falls back to
       *  the historical t2i path with no refs. */
      stylePreset?: string;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Accept either the new `cells` shape (preferred) or the legacy
    // `prompts` shape. `cells` carries the per-row metadata needed to
    // run augmentCellPrompt per cell; `prompts` is augmentation-free
    // and stays around for the dev tester + back-compat.
    let cells: CollageCellInput[];
    if (Array.isArray(body.cells)) {
      cells = body.cells;
    } else if (Array.isArray(body.prompts)) {
      cells = body.prompts.map((prompt) => ({ prompt: typeof prompt === 'string' ? prompt : '' }));
    } else {
      return NextResponse.json(
        { error: '`cells` or `prompts` must be an array of exactly 4 entries' },
        { status: 400 },
      );
    }
    if (cells.length !== 4) {
      return NextResponse.json(
        { error: 'Exactly 4 cells are required' },
        { status: 400 },
      );
    }
    if (cells.some((c) => typeof c?.prompt !== 'string' || c.prompt.trim().length === 0)) {
      return NextResponse.json(
        { error: 'Every cell must have a non-empty `prompt` string' },
        { status: 400 },
      );
    }
    // Raw per-cell cap is 1500 chars on the input prompt
    // (bumped 2026-05-31 from 400 → 1500). augmentCellPrompt pushes the
    // final augmented cell up to COLLAGE_CELL_PROMPT_CAP (600), and
    // composed-with-scaffolding stays under the model's ~12000-char
    // limit at 4×1500 + overhead. The 400-char cap was too tight for
    // styles whose `ai_image_suffix` is verbose (doodle_explainer_2's
    // emitted prompts run 700-900 chars per cell). Below 1500 the route
    // would reject doodle_explainer_2 calls with 400, sending the page
    // to the per-row single-shot fallback — killing the cost savings
    // the collage path exists for.
    if (cells.some((c) => c.prompt.trim().length > 1500)) {
      return NextResponse.json(
        { error: 'Each cell prompt must be at most 1500 characters' },
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

    // 2026-05-31 (plan §C) — refs-aware collage. When the page passes
    // `stylePreset` AND the style ships with refs (e.g. doodle_explainer_2's
    // 4 built-in doodle anchors), resolve them to URLs and route through
    // Atlas i2i so every cell of the 2×2 output inherits the style refs
    // — instead of the historical t2i call that silently dropped them.
    // Refs-aware mode only fires on Atlas (the only provider in our
    // codebase that supports i2i with refs); Kie styles + refs return
    // `fallback_needed` so the page drops to single-shot (which DOES use
    // refs via the existing i2i dispatcher).
    const stylePresetParam = typeof body.stylePreset === 'string' ? body.stylePreset.trim() : '';
    let refImageUrls: string[] = [];
    if (stylePresetParam) {
      try {
        const style = await resolveStyle(stylePresetParam, session.ws, null);
        if (style) {
          const refs = await loadStyleReferences(style.id, {
            excludeRejected: true,
            excludeUnvalidated: true,
            workspaceId: session.ws,
          });
          if (refs.length > 0) {
            refImageUrls = await Promise.all(
              refs.map((r) =>
                r.public_url
                  ? mirrorPublicUrlRefToR2(r)
                  : getDownloadUrlForBucket(r.r2_bucket, r.r2_key, undefined),
              ),
            );
          }
        }
      } catch (err) {
        logger.warn('[collage refs] resolution failed — falling back to t2i path', {
          stylePreset: stylePresetParam,
          error: err instanceof Error ? err.message : String(err),
        });
        refImageUrls = [];
      }
    }
    const refsAware = refImageUrls.length > 0 && spec.provider === 'atlas';
    // Atlas i2i caps at 4 refs — cap defensively here so a saved style
    // with more refs doesn't blow the model limit. First 4 in declared
    // order; the style author owns ref priority.
    const ATLAS_I2I_MAX_REFS = 4;
    const cappedRefs = refsAware ? refImageUrls.slice(0, ATLAS_I2I_MAX_REFS) : [];
    if (refImageUrls.length > 0 && spec.provider !== 'atlas') {
      logger.warn('[collage refs] style has refs but provider is non-Atlas — refs cannot be threaded', {
        stylePreset: stylePresetParam,
        provider: spec.provider,
        ref_count: refImageUrls.length,
      });
    }
    logger.info('[collage refs] eligibility', {
      stylePreset: stylePresetParam,
      ref_count_loaded: refImageUrls.length,
      refs_aware: refsAware,
      refs_will_send: cappedRefs.length,
      provider: spec.provider,
    });

    // ─── Try → detect malformed → retry once → fallback ────────────────
    let attemptCount = 0;
    let upscaledUrl: string | null = null;
    let upscaledBuf: Buffer | null = null;
    let malformedIndices: number[] = [];
    let lastError = '';

    // Per-cell augmentation runs once (the directives don't change
    // between attempts; only the composed scaffolding does on the
    // reinforced retry). Captured here so we can log the per-cell
    // augmentation state before the loop and avoid double-logging on
    // the retry.
    const augmented = cells.map((cell, index) => {
      const result = augmentCellPrompt({
        prompt: cell.prompt,
        onScreenText: cell.onScreenText,
        onScreenTextMode: cell.onScreenTextMode,
        sectionTitle: cell.sectionTitle,
        sectionTitleLayout: cell.sectionTitleLayout,
        styleSheetDescription: cell.styleSheetDescription,
        promptCap: COLLAGE_CELL_PROMPT_CAP,
        source: `collage-cell-${index}`,
      });
      return result;
    });
    logger.info('[collage generate] cells composed', {
      model: spec.value,
      provider: spec.provider,
      cells: augmented.map((a, i) => ({
        index: i,
        ost_baked: a.ostBaked,
        safe_top: a.safeTop,
        sheet_desc: a.sheetDesc,
        truncated: a.truncated,
        augmented_len: a.prompt.length,
      })),
    });
    const augmentedPrompts = augmented.map((a) => a.prompt);

    for (let attempt = 1; attempt <= 2; attempt++) {
      attemptCount = attempt;
      const composedPrompt = composeCollagePrompt(augmentedPrompts, attempt === 2);
      const t0 = Date.now();
      // One audit row PER attempt — each is a separate paid provider
      // call, so reconciliation needs to see both rows if both fired
      // and a refund/recovery is owed for both.
      const attemptIntent = await recordIntent({
        userId: session.uid,
        workspaceId: session.ws,
        route: '/api/generate/production-doc/collage',
        provider: spec.provider === 'atlas' ? 'atlas' : 'kie',
        providerModel: `${spec.value}${refsAware ? '#i2i' : ''}#attempt-${attempt}`,
      });
      pendingIntentId = attemptIntent.id;
      let attemptProviderRequestId: string | null = null;
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
          // Atlas collage: HARDCODED to 1536×1024 (3:2) → crop to 1536×864
          // (16:9) → Recraft 4× upscale → ~6144×3456 → 4 quadrants of
          // ~3072×1728 each (~3K per shot, matches the Kie collage path).
          //
          // We deliberately override the registry's `atlasSize` here even
          // when the user picked the 2560×1440 default for single-shot
          // generation. The reason is geometry: a 2560×1440 collage
          // sliced into 4 quadrants yields only 1280×720 per shot
          // (720p), well below the pipeline's per-shot resolution target.
          // The user locked this trade-off 2026-05-25 ("collage must
          // upscale") — single-shot stays at 2K skip-upscale, collage
          // takes the upscale hit so each quadrant lands at usable
          // resolution. Quality stays on the spec's default ('low' per
          // the registry) because Recraft will sharpen.
          // 2026-05-31 (plan §C) — refs-aware variant. When `refsAware`,
          // call Atlas i2i with the style refs as inputs so every cell
          // of the 2×2 inherits the style aesthetic. Otherwise the
          // original t2i path. Same 1536×1024 source, same downstream
          // crop + upscale + slice. Costs the same as t2i (Atlas charges
          // by Edit/I2I model, same SKU as Edit at low quality).
          const atlasResult = refsAware
            ? await generateAtlasI2I({
                prompt: composedPrompt,
                images: cappedRefs,
                size: '1536x1024',
                quality: spec.atlasQuality ?? 'low',
              })
            : await generateAtlasT2I({
                prompt: composedPrompt,
                size: '1536x1024',
                quality: spec.atlasQuality ?? 'low',
              });
          attemptProviderRequestId = atlasResult.predictionId ?? null;
          logger.info('[collage atlas-generate] vendor done', {
            attempt,
            prediction_id: atlasResult.predictionId,
            predict_ms: atlasResult.predictTimeMs,
            forced_size: '1536x1024',
            spec_size: spec.atlasSize,
            refs_aware: refsAware,
            refs_sent: cappedRefs.length,
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
          attemptProviderRequestId = taskId;
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
          // Provider call succeeded AND produced a usable image — mark
          // delivered so reconciliation knows this row is not orphan.
          void markDelivered({
            id: attemptIntent.id,
            providerRequestId: attemptProviderRequestId,
            responseUrl: url,
            costUsd: null,
            durationMs: Date.now() - t0,
          });
          pendingIntentId = null;
          upscaledUrl = url;
          upscaledBuf = buf;
          malformedIndices = [];
          break; // success — out of retry loop
        }

        // Malformed-quadrant case: provider was charged but the output
        // is unusable. Mark this attempt's row failed with the indices
        // — reconciliation surfaces these to the user so a refund can
        // be requested.
        malformedIndices = detection.malformedIndices;
        void markFailed({
          id: attemptIntent.id,
          failureReason: `malformed_quadrants:${malformedIndices.join(',')}`,
          providerRequestId: attemptProviderRequestId,
          durationMs: Date.now() - t0,
        });
        pendingIntentId = null;
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
        // Mark this attempt's audit row failed. Provider may or may not
        // have charged depending on where in the call the throw happened;
        // the reason text gives reconciliation enough to decide.
        void markFailed({
          id: attemptIntent.id,
          failureReason: lastError,
          providerRequestId: attemptProviderRequestId,
          durationMs: Date.now() - t0,
        });
        pendingIntentId = null;
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
    if (pendingIntentId) {
      void markFailed({
        id: pendingIntentId,
        failureReason: err instanceof Error ? err.message : String(err),
      });
    }
    logger.error('Collage image generation error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Collage generation failed' },
      { status: 500 },
    );
  }
});


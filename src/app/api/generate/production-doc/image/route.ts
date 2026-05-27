import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  buildKieImageInput,
  getImageModelSpec,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
} from '@/lib/image-models';
import {
  DEFAULT_CLOUD_I2I_MODEL,
  getI2IModelSpec,
} from '@/lib/image-models-i2i';
import { computeImageSaliency } from '@/lib/image-saliency';
import { createKieTask, pollKieResultThenUpscale } from '@/lib/kie-poll';
import { generateImageWithUpscale } from '@/lib/image-gen-dispatch';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';
import { computeImageCanvas } from '@/lib/render-canvas';
import { uploadUrlToComfyInput } from '@/lib/comfyui/upload';
import { checkSafePublicUrl } from '@/lib/url-safety';
import { apiRoute } from '@/lib/route-helpers';
import { resolveStyle } from '@/lib/production-doc-styles';
import { loadStyleReferences, markReferenceRejected } from '@/lib/production-doc-styles-refs';
import { generateImageWithRefs, ReferenceRejectedError } from '@/lib/image-gen-i2i';
import { augmentCellPrompt, SINGLE_SHOT_PROMPT_CAP } from '@/lib/prompt-augmentation';
import {
  PROMPT_VERSION,
  useShortVariantPrompt,
  useTrimmedSuffix,
  type ImageGenTelemetry,
} from '@/lib/production-doc-flags';

export const maxDuration = 300;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  try {
    // Two-layer rate limit. The IP limit blocks one machine going
    // wild. The per-user limit blocks one account from running up
    // spend behind rotating proxies — at ~$0.05/i2i call, 30/min/IP
    // alone permits $90/hour of authenticated cost-bomb attack.
    // 30/min per session.uid is the same ceiling but keyed to the
    // identity that actually pays, so proxy rotation doesn't bypass.
    // Rule 8 (cost discipline) applied as defense-in-depth.
    const ipLimit = checkRateLimit(`prodoc-img:${getClientIP(req)}`, 30, 60_000);
    if (ipLimit.limited) return NextResponse.json({ error: 'Rate limited (IP)' }, { status: 429 });
    const userLimit = checkRateLimit(`prodoc-img-uid:${session.uid}`, 30, 60_000);
    if (userLimit.limited) return NextResponse.json({ error: 'Rate limited (account) — slow down on image generation' }, { status: 429 });

    let body: {
      prompt?: string;
      model?: string;
      onScreenText?: string;
      onScreenTextMode?: 'bake' | 'overlay' | 'none';
      sectionTitle?: string;
      sectionTitleLayout?: 'overlay' | 'letterbox';
      /** Phase 7: per-doc style-sheet URL. Triggers i2i chaining on the
       *  local-ComfyUI path; appended as a textual description hint on
       *  the cloud-Kie path via `styleSheetDescription`. */
      referenceImageUrl?: string;
      /** Phase 7: short prose description of the sheet. Used as a
       *  prompt-augmentation hint on cloud-Kie generations (Kie models
       *  don't accept arbitrary reference images for style chaining). */
      styleSheetDescription?: string;
      /** v2 (2026-05-21): style id whose refs + preferred_cloud_model
       *  should govern this generation. When set AND the style has
       *  unrejected refs, the route routes the call through the i2i
       *  dispatcher instead of the legacy T2I path. When set but the
       *  style has no usable refs, falls through to T2I unchanged
       *  (the style's ai_image_suffix is already baked into `prompt`
       *  by the prompt-builder upstream). */
      styleId?: string;
      /** v2: explicit exclude list for the "Regenerate without
       *  rejected refs" affordance. Refs in this list are dropped from
       *  the dispatched call even if their `rejected_by_provider` flag
       *  isn't set yet. */
      excludeRefIds?: string[];
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { prompt, model, onScreenText, onScreenTextMode, sectionTitle, sectionTitleLayout, referenceImageUrl, styleSheetDescription, styleId, excludeRefIds } = body;
    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }
    // Parse layout against the literal union; anything else collapses to
    // the production-doc render-time default of 'letterbox'.
    const normalizedLayout: 'overlay' | 'letterbox' =
      sectionTitleLayout === 'overlay' || sectionTitleLayout === 'letterbox'
        ? sectionTitleLayout
        : 'letterbox';
    // OST mode controls whether we bake the text into the diffusion prompt
    // (and thus into the image pixels) or leave it for Remotion's LowerThird
    // to composite at render time. Default to 'bake' for back-compat with
    // any caller that doesn't pass the field yet. See
    // `_plans/2026-05-21-phase-5-text-mode-toggle.md`.
    const normalizedOstMode: 'bake' | 'overlay' | 'none' =
      onScreenTextMode === 'bake' || onScreenTextMode === 'overlay' || onScreenTextMode === 'none'
        ? onScreenTextMode
        : 'bake';

    // Compute the exact pixel canvas the still should target so it lands
    // pixel-clean inside the Remotion composition that displays it. See
    // _plans/2026-05-21-resolution-aware-generation.md.
    const canvas = computeImageCanvas({
      sectionTitle,
      sectionTitleLayout: normalizedLayout,
    });

    // Per-cell prompt augmentation. The augmentation logic itself lives
    // in `src/lib/prompt-augmentation.ts` so the collage route applies
    // the same directives per cell and produces byte-identical output
    // for matching inputs. Changing the augmentation surface here means
    // changing it there too — keep the helper as the single source of
    // truth and only edit this call site for new directive *inputs*.
    //
    // The body's `prompt` contains the LLM's scene description plus the
    // style suffix appended server-side (see attachStyleSuffixToRows).
    // For verbose styles (doodle_explainer_2's suffix is 1.9 kB on its
    // own) the augmented total can exceed the cap. The helper truncates
    // the `prompt` portion from the tail so the most-important leading
    // text (the scene body + the critical first rules of the style
    // suffix) is preserved. Refs (when present via the i2i path below)
    // carry the visual style independently, so the trailing suffix
    // detail being dropped is acceptable degradation. Image models also
    // weight late tokens heavily for "what must appear" — the OST +
    // sheet-desc directives sit AFTER the truncated body, so they're
    // never lost.
    const augmented = augmentCellPrompt({
      prompt,
      onScreenText,
      onScreenTextMode: normalizedOstMode,
      sectionTitle,
      sectionTitleLayout: normalizedLayout,
      styleSheetDescription,
      promptCap: SINGLE_SHOT_PROMPT_CAP,
      source: 'prodoc-single-shot',
    });
    const augmentedPrompt = augmented.prompt;

    // ─── v2 ref-bearing i2i dispatch (Phase 4 of the May 21 plan) ────
    //
    // When the caller passes `styleId`, resolve the style and load its
    // current refs. If at least one usable (non-rejected, not in
    // excludeRefIds) ref exists, route the call through the i2i
    // dispatcher instead of the legacy T2I path. The style's
    // `preferred_cloud_model` chooses which Kie i2i variant runs —
    // defaulting to NanoBanana Pro (Phase 0 cloud spike winner).
    //
    // When styleId is set but the style has no usable refs (deleted,
    // all rejected, all excluded), we fall through to the existing
    // T2I flow — the style's `ai_image_suffix` is already in
    // `augmentedPrompt` because the prompt-builder upstream appends
    // it during prompt composition.
    //
    // When styleId is not set, this whole block is a no-op and the
    // legacy T2I path runs as before.
    const trimmedStyleId = styleId?.trim();
    if (trimmedStyleId) {
      const style = await resolveStyle(trimmedStyleId, session.ws, session.uid);
      // v3 (2026-05-22): built-ins can now carry refs natively via
      // `built_in_refs`. Drop the origin === 'saved' gate so a built-in
      // with bundled refs (e.g. Doodle Explainer) also routes through
      // the i2i dispatcher. loadStyleReferences short-circuits for
      // built-in slugs and synthesizes the static-URL ref rows; the
      // dispatcher reads `public_url` instead of presigning R2.
      if (style) {
        const refs = await loadStyleReferences(style.id, {
          excludeRejected: true,
          // Block refs that failed the post-upload MIME sniff
          // (migration 0082). Refs whose validation hasn't completed
          // yet are also excluded — the editor calls /validate
          // immediately after PUT but there's a small gap during
          // which a generation against a fresh ref would be blocked.
          excludeUnvalidated: true,
          excludeIds: excludeRefIds ?? [],
          workspaceId: session.ws,
        });
        if (refs.length > 0) {
          const i2iModel = style.preferred_cloud_model ?? DEFAULT_CLOUD_I2I_MODEL;
          const i2iSpec = getI2IModelSpec(i2iModel);
          logger.info('[prodoc image-gen i2i submit]', {
            style_id: style.id,
            style_version: style.version,
            model: i2iModel,
            provider: i2iSpec?.provider ?? 'unknown',
            refs_loaded: refs.length,
            prompt_slice: augmentedPrompt.slice(0, 80),
          });
          // Foundation telemetry (Stage 0). Attributes this generation to
          // a prompt version, style + version, ref set, suffix size, and
          // flag state so post-ship regressions are forensically
          // traceable. Plan: _plans/2026-05-27-doodle-explainer-2-foundation.md.
          logger.info('[prodoc image-gen telemetry]', {
            prompt_version: PROMPT_VERSION,
            style_id: style.id,
            style_version: style.version ?? null,
            ref_count: refs.length,
            ref_ids: refs.map((r) => r.id),
            suffix_chars: (style.ai_image_suffix ?? '').length,
            prompt_chars: augmentedPrompt.length,
            flag_short_variant: useShortVariantPrompt(),
            flag_trimmed_suffix: useTrimmedSuffix(),
          } satisfies ImageGenTelemetry);

          // ─── Unified i2i dispatch (cloud + local via the shared helper) ──
          //
          // `generateImageWithRefs` branches on `spec.provider`:
          //   - `kie` → cloud i2i (NanoBanana/GPT-Image-2/Flux-2-Pro)
          //   - `comfyui-local` → local Qwen via `generateImageWithRefsLocal`
          //
          // Both paths re-host the result to R2 internally so the
          // returned URL is durable. The helper throws plain Errors for
          // local-infra problems (LOCAL_STUDIO=1 missing, ComfyUI
          // unreachable) which the catch below maps back to 503 with
          // the same code shape the inline implementation used to
          // return — preserving the editor's error-handling contract.
          try {
            const result = await generateImageWithRefs(i2iModel, augmentedPrompt, refs, {
              r2KeyPrefix: i2iSpec?.provider === 'comfyui-local'
                ? 'prodoc-images-i2i-local'
                : 'prodoc-images-i2i',
              // Local-only; cloud ignores. Honours the section-title
              // letterbox so the still lands pixel-clean inside the
              // Remotion composition that displays it.
              width: canvas.width,
              height: canvas.height,
            });
            // Saliency mirrors the T2I path: fetch the result bytes
            // and pass to computeImageSaliency. Failure is non-
            // blocking; the overlay placement resolver falls back to
            // the LLM-planned zone when saliency is null.
            let imageBuffer: Buffer | null = null;
            try {
              const imgRes = await fetch(result.imageUrl);
              if (imgRes.ok) {
                imageBuffer = Buffer.from(await imgRes.arrayBuffer());
              }
            } catch (saliencyFetchErr) {
              logger.warn('[prodoc image-gen i2i saliency fetch failed]', {
                detail: saliencyFetchErr instanceof Error ? saliencyFetchErr.message : String(saliencyFetchErr),
              });
            }
            const saliency = imageBuffer ? await computeImageSaliency(imageBuffer) : null;
            return NextResponse.json({
              imageUrl: result.imageUrl,
              saliency,
              modelUsed: result.modelUsed,
              styleVersion: style.version,
              refsSent: result.refsSent,
              durationMs: result.durationMs,
            });
          } catch (err) {
            if (err instanceof ReferenceRejectedError) {
              // Mark the offending refs server-side so future
              // generations under this style skip them by default.
              // Best-effort — marking failure doesn't shadow the
              // refusal surface to the client.
              for (const refId of err.rejectedRefIds) {
                await markReferenceRejected(refId, style.id, err.reason, err.provider).catch(() => {
                  logger.warn('[prodoc image-gen i2i mark-rejected failed]', {
                    style_id: style.id,
                    ref_id: refId,
                  });
                });
              }
              logger.info('[prodoc image-gen ref-rejected]', {
                style_id: style.id,
                ref_ids: err.rejectedRefIds,
                provider: err.provider,
              });
              return NextResponse.json(
                {
                  error: err.message,
                  code: 'REFERENCE_REJECTED',
                  rejectedRefIds: err.rejectedRefIds,
                  suggestRegenerate: true,
                },
                { status: 409 },
              );
            }
            // Local-infra failures bubble up from
            // `generateImageWithRefsLocal` as plain Errors with
            // specific message prefixes. Promote them to 503 with the
            // editor-actionable codes the dialog already knows how to
            // surface (rule 16 — give the user a clear next step).
            if (err instanceof Error) {
              if (err.message.includes('LOCAL_STUDIO=1')) {
                return NextResponse.json(
                  { error: err.message, code: 'LOCAL_STUDIO_DISABLED' },
                  { status: 503 },
                );
              }
              if (err.message.includes('ComfyUI not reachable')) {
                return NextResponse.json(
                  { error: err.message, code: 'COMFYUI_UNREACHABLE' },
                  { status: 503 },
                );
              }
            }
            // Non-rejection / non-local-infra failures fall through to
            // the outer catch so they're logged + returned consistently
            // with the rest of this route.
            throw err;
          }
        }
        // No usable refs → fall through to T2I. (The style's
        // ai_image_suffix is already in augmentedPrompt from the
        // upstream prompt-builder, so the legacy path produces a
        // style-flavoured T2I result without further changes.)
      }
    }

    const modelValue = model?.trim() || DEFAULT_IMAGE_MODEL;
    const spec = getImageModelSpec(modelValue);
    if (!spec) {
      return NextResponse.json(
        { error: `Unknown image model: ${modelValue}. Valid: ${IMAGE_MODELS.map(m => m.value).join(', ')}` },
        { status: 400 },
      );
    }

    // Dispatch on provider: local ComfyUI vs. Kie cloud.
    //
    // Local path: invoke the ComfyUI generator, get the proxy URL, then
    // fetch bytes from the ComfyUI /view endpoint server-side (same
    // origin so no CORS dance) to compute saliency. Skip the R2 mirror
    // entirely — the proxy URL is local-only by contract.
    if (spec.provider === 'comfyui-local') {
      if (process.env.LOCAL_STUDIO !== '1') {
        return NextResponse.json(
          {
            error:
              'Local image generation requires LOCAL_STUDIO=1. Start the dev server with `$env:LOCAL_STUDIO=1; npm run dev` and ensure ComfyUI is running on localhost:8188.',
          },
          { status: 503 },
        );
      }
      if (!spec.localWorkflowId) {
        return NextResponse.json(
          { error: `Local model '${spec.value}' has no localWorkflowId mapping` },
          { status: 500 },
        );
      }
      const { ComfyUILocalGenerator } = await import('@/lib/visual-generator/comfyui-local');
      const { ComfyUIClient } = await import('@/lib/comfyui/client');
      const generator = new ComfyUILocalGenerator();
      if (!(await generator.isReachable())) {
        return NextResponse.json(
          { error: 'ComfyUI not reachable on localhost:8188 — start it and try again.' },
          { status: 503 },
        );
      }
      // Phase 7: when the caller passes a style-sheet URL, fetch it from
      // R2 and upload to ComfyUI's input/ folder. The local generator
      // auto-swaps to the i2i variant of the chosen workflow when
      // `refImageFilename` is present (see
      // `src/lib/visual-generator/comfyui-local.ts`). Denoise 0.7 ≈
      // sweet-spot for "same style + character, fresh composition".
      let refImageFilename: string | undefined;
      const trimmedRefUrl = referenceImageUrl?.trim();
      if (trimmedRefUrl) {
        // SSRF guard — `referenceImageUrl` is caller-supplied (Phase 7
        // style-sheet chaining), and the local path fetches it
        // server-side. Block private / internal / metadata hosts via
        // the project's url-safety helper. Without this, an
        // authenticated user can use this endpoint to make the
        // ComfyUI box (and the Next.js server) reach cloud metadata
        // services or RFC1918 ranges. Fail soft to legacy T2I so a
        // misformatted URL doesn't 5xx the whole row.
        const urlSafety = checkSafePublicUrl(trimmedRefUrl);
        if (!urlSafety.ok) {
          logger.warn('[prodoc image-gen] referenceImageUrl rejected by SSRF guard', {
            reason: urlSafety.error,
            url_preview: trimmedRefUrl.slice(0, 100),
          });
        } else {
          try {
            refImageFilename = await uploadUrlToComfyInput(trimmedRefUrl, {
              filenamePrefix: 'style-sheet-ref',
            });
          } catch (uploadErr) {
            // Fail soft: chaining is a quality-of-life upgrade, not a hard
            // requirement. Log + fall back to t2i so the user still gets
            // an image rather than a 5xx.
            logger.warn('[prodoc image-gen] style-sheet upload failed — falling back to t2i', {
              url_preview: trimmedRefUrl.slice(0, 100),
              detail: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
            });
          }
        }
      }

      const hasSectionStripe = Boolean(sectionTitle?.trim());
      logger.info('[prodoc image-gen] canvas resolved', {
        model: spec.value,
        width: canvas.width,
        height: canvas.height,
        letterboxed: canvas.letterboxed,
        stripe_height_px: canvas.stripeHeightPx,
        section_title: hasSectionStripe,
        layout: hasSectionStripe ? normalizedLayout : 'none',
        ost_mode: normalizedOstMode,
        ost_baked: augmented.ostBaked,
        chained_to_sheet: Boolean(refImageFilename),
      });
      const result = await generator.generateImage(augmentedPrompt, {
        workflowId: spec.localWorkflowId,
        width: canvas.width,
        height: canvas.height,
        refImageFilename,
        denoise: refImageFilename ? 0.7 : undefined,
      });
      // Compute saliency directly from ComfyUI's bytes (skip the proxy
      // round-trip — we're already server-side).
      let imageBuffer: Buffer | null = null;
      try {
        const m = result.url.match(
          /\bfilename=([^&]+).*?subfolder=([^&]*).*?type=([^&]+)/,
        );
        if (m) {
          const comfy = new ComfyUIClient();
          const { bytes } = await comfy.fetchOutputBytes({
            filename: decodeURIComponent(m[1]),
            subfolder: decodeURIComponent(m[2]),
            type: decodeURIComponent(m[3]) as 'output' | 'temp' | 'input',
          });
          imageBuffer = Buffer.from(bytes);
        }
      } catch (fetchErr) {
        logger.warn('Local image saliency fetch failed', {
          detail: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        });
      }
      const saliency = imageBuffer ? await computeImageSaliency(imageBuffer) : null;
      return NextResponse.json({ imageUrl: result.url, saliency });
    }

    // ─── Atlas Cloud branch ─────────────────────────────────────────────
    // The Atlas provider routes through `generateImageWithUpscale` which
    // handles the full async create+poll, the 16:9 center-crop (Atlas's
    // GPT Image 2 returns 3:2 at most), the system-wide auto-upscale, and
    // the R2 mirror. Returns the bytes too so saliency runs without a
    // second fetch. Falls through to the Kie path when provider is
    // anything other than 'atlas'. See
    // _plans/2026-05-25-atlas-cloud-gpt-image-2.md (Phase 1.B).
    if (spec.provider === 'atlas') {
      const result = await generateImageWithUpscale(spec, augmentedPrompt);
      const saliencyStart = Date.now();
      const saliency = result.bytes ? await computeImageSaliency(result.bytes) : null;
      logger.info('[prodoc image-gen atlas] done', {
        model: spec.value,
        image_url_host: (() => { try { return new URL(result.url).hostname; } catch { return 'unknown'; } })(),
        duration_ms: result.durationMs,
        saliency_ms: Date.now() - saliencyStart,
        has_saliency: Boolean(saliency),
      });
      return NextResponse.json({ imageUrl: result.url, saliency });
    }

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 });
    }

    if (!spec.kieModel) {
      return NextResponse.json(
        { error: `Kie model '${spec.value}' missing kieModel mapping` },
        { status: 500 },
      );
    }

    const taskId = await createKieTask(apiKey, spec.kieModel, buildKieImageInput(spec.value, augmentedPrompt));
    // System-wide auto-upscale: every cloud generation lands at ~4K via
    // Recraft Crisp Upscale before the R2 mirror below picks it up.
    // Skips kick in for >2000px outputs and when AUTO_UPSCALE_ENABLED=false.
    // See src/lib/upscale.ts.
    const kieUrl = await pollKieResultThenUpscale(taskId, apiKey);

    // Re-host in R2 (images bucket) so the URL doesn't depend on Kie's
    // CDN retention. On mirror failure fall back to the Kie URL —
    // image still usable until the upstream expires.
    //
    // The earlier "safe-top crop" step that removed the top 13% of every
    // section-titled image is gone: it destroyed real content (legends,
    // sketched titles, top elements of uploads) for the sake of clearing
    // the stripe zone. The letterbox layout at render time now handles
    // the stripe geometry without ever mutating the image. The safe-top
    // *prompt* directive stays — it's free and biases AI composition
    // toward the lower 87% which still helps in overlay mode and is a
    // bonus in letterbox mode.
    //
    // After upload we also compute a pixel-saliency map of the image
    // so the overlay placement resolver can land overlays on empty
    // cells instead of focal content. Saliency is best-effort: a
    // failure just returns null on the response and the renderer falls
    // back to the LLM's planned zone.
    let imageUrl = kieUrl;
    let imageBuffer: Buffer | null = null;
    try {
      const imgRes = await fetch(kieUrl);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        imageBuffer = buffer;
        const outContentType = contentType;
        const outExt = contentType.includes('png') ? 'png' : 'jpg';

        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `prodoc-images/${Date.now()}-${randomSuffix}.${outExt}`;
        await uploadToBucket(bucket, r2Key, buffer, outContentType);
        imageUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      }
    } catch (uploadErr) {
      console.warn('[image-gen] R2 upload failed, falling back to Kie.ai URL:', uploadErr);
    }

    const saliencyStart = Date.now();
    const saliency = imageBuffer ? await computeImageSaliency(imageBuffer) : null;
    console.info('[saliency compute] done', {
      hasImage: Boolean(imageBuffer),
      hasResult: Boolean(saliency),
      busyness: saliency?.busyness,
      dominantColors: saliency?.dominantColors,
      ms: Date.now() - saliencyStart,
    });

    return NextResponse.json({ imageUrl, saliency });
  } catch (err: unknown) {
    logger.error('Production doc image generation error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Image generation failed' },
      { status: 500 },
    );
  }
});

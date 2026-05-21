import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { buildKieImageInput, getImageModelSpec, DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/image-models';
import { computeImageSaliency } from '@/lib/image-saliency';
import { createKieTask, pollKieResult } from '@/lib/kie-poll';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';
import { computeImageCanvas } from '@/lib/render-canvas';
import { uploadUrlToComfyInput } from '@/lib/comfyui/upload';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    // Separate rate limit key from thumbnails; higher ceiling for bulk generation
    const { limited } = checkRateLimit(`prodoc-img:${getClientIP(req)}`, 30, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

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
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { prompt, model, onScreenText, onScreenTextMode, sectionTitle, sectionTitleLayout, referenceImageUrl, styleSheetDescription } = body;
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

    // Safe-top scene bias — only useful when the stripe will overlay the
    // image (covering its top). When the stripe is letterboxed, we now
    // generate at the exact visible canvas, so biasing the prompt is
    // redundant and only crowds the input. Phrased as plain scene
    // description, not imperative meta-instruction: directives like
    // "LAYOUT CONSTRAINT — Leave the top 13% as negative space, do NOT
    // place faces…" get rendered verbatim into the image by diffusion
    // models, which can't distinguish rules-to-follow from text-to-draw.
    const hasSectionStripe = Boolean(sectionTitle?.trim());
    const needsSafeTopBias = hasSectionStripe && normalizedLayout === 'overlay';
    const safeTopDirective = needsSafeTopBias
      ? `Wide composition with an empty open sky or plain low-detail background across the upper portion of the frame. All characters, faces, objects, and key details sit in the lower portion.\n\n`
      : '';

    // OST baking. Sanitise stray newlines and cap at 120 chars so a
    // malformed string can't smuggle other directives into the prompt.
    // Phrased as a short scene element ("Hand-lettered text 'X' drawn
    // in bold marker style") rather than an imperative ("INCLUDE THE
    // WORDS — do NOT abbreviate…"). The imperative version was being
    // rendered verbatim into the output image alongside the actual
    // words. The phrase is repeated, terse, at the end of the prompt
    // because image models weight late tokens heavily for "what must
    // appear in the image".
    // When mode is 'overlay' or 'none', the LowerThird (or nothing) renders
    // the text at composition time — we deliberately keep the underlying
    // image clean of in-prompt text so the diffusion model can't garble it.
    // Sanitisation still happens up-front so the same safeOnScreenText
    // value is available for downstream logging if needed in future.
    const safeOnScreenText = (onScreenText ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
    const escapedOst = safeOnScreenText.replace(/"/g, '\\"');
    const shouldBakeOst = normalizedOstMode === 'bake' && safeOnScreenText.length > 0;
    // OST sits below the stripe only when the stripe overlays the image.
    // Letterbox layout already crops the canvas so OST can land anywhere.
    const ostPosition = needsSafeTopBias
      ? 'in the lower portion of the frame'
      : 'within the scene';
    const ostLeadingDirective = shouldBakeOst
      ? `Hand-lettered text "${escapedOst}" drawn large in bold marker style ${ostPosition}, in the illustration's own style.\n\n`
      : '';
    const ostTrailingDirective = shouldBakeOst
      ? `\n\nText shown: "${escapedOst}".`
      : '';

    // Phase 7: cloud-Kie chaining. Kie models can't accept a reference image
    // for style conditioning, so we append the doc's textual sheet
    // description to the prompt as a hint. Sanitised + capped before
    // injection — same belt-and-braces as the OST sanitiser above.
    const safeSheetDesc = (styleSheetDescription ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 240);
    const sheetDescDirective = safeSheetDesc
      ? `\n\nMaintain visual continuity with the established style: ${safeSheetDesc}.`
      : '';

    const augmentedPrompt = `${safeTopDirective}${ostLeadingDirective}${prompt.trim()}${ostTrailingDirective}${sheetDescDirective}`;

    // Length cap applies to what we ACTUALLY send to Kie — the augmented
    // prompt — not the original. Raised to 2000 to leave room for the
    // OST directive overhead (~150 chars) on top of the existing budget.
    if (augmentedPrompt.length > 2000) {
      return NextResponse.json({ error: 'Prompt too long — maximum 2000 characters' }, { status: 400 });
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

      logger.info('[prodoc image-gen] canvas resolved', {
        model: spec.value,
        width: canvas.width,
        height: canvas.height,
        letterboxed: canvas.letterboxed,
        stripe_height_px: canvas.stripeHeightPx,
        section_title: Boolean(sectionTitle?.trim()),
        layout: hasSectionStripe ? normalizedLayout : 'none',
        ost_mode: normalizedOstMode,
        ost_baked: shouldBakeOst,
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
    const kieUrl = await pollKieResult(taskId, apiKey);

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
}

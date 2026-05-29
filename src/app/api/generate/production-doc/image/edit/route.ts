import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { computeImageSaliency } from '@/lib/image-saliency';
import {
  createFluxKontextTask,
  createGpt4oImageTask,
  createKieTask,
  pollFluxKontextResultThenUpscale,
  pollGpt4oImageResultThenUpscale,
  pollKieResultThenUpscale,
} from '@/lib/kie-poll';
import { generateGptImage2Edit } from '@/lib/gpt-image-2-edit';
import { getUserSettings } from '@/lib/user-settings';
import {
  PROMPT_VERSION,
  isShortVariantPromptEnabled,
  isTrimmedSuffixEnabled,
  type ImageGenTelemetry,
} from '@/lib/production-doc-flags';
import { upscaleViaRecraft } from '@/lib/upscale';
import { checkSafePublicUrl } from '@/lib/url-safety';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';
import {
  DEFAULT_ERASE_OPTION_ID,
  ERASE_PROMPT,
  getEditOption,
  type EditOption,
  type EditOptionId,
} from '@/lib/image-edit-pricing';
import { recordIntent, markDelivered, markFailed } from '@/lib/provider-generations';

export const maxDuration = 300;

/**
 * Edit an image on a production-doc row.
 *
 * The model catalog lives in `src/lib/image-edit-pricing.ts` — the
 * single source of truth shared with the UI. This route's job is to
 * (a) validate the requested option id, (b) build the per-backend
 * input shape, (c) call the right Kie endpoint, (d) mirror the result
 * to R2 and compute saliency. The UI's picker labels + prices come
 * from the same catalog, so adding a new model means appending one
 * entry there and (if it needs a new backend) one branch here.
 *
 * Three backends:
 *
 *   1. `kie-standard`   — POST /api/v1/jobs/createTask with
 *      `{ model, input }`. Covers Nano Banana, Qwen, Qwen2, Seedream,
 *      and Ideogram v3 (the last one requires `mask_url`).
 *   2. `kie-gpt4o`      — POST /api/v1/gpt4o-image/generate. The only
 *      one with a `quality` price tier. Mask-required.
 *   3. `flux-kontext`   — POST /api/v1/flux/kontext/generate. Camel-
 *      case input shape (`inputImage`, `aspectRatio`, `outputFormat`).
 *
 * **Erase intent.** When the client posts `intent: 'erase'`, the route
 * forces the option to `DEFAULT_ERASE_OPTION_ID` (a mask-capable
 * option, configurable in editor settings) and substitutes the server-
 * generated `ERASE_PROMPT`. The client never sends the erase prompt
 * itself, so a tampered client can't spoof an intent and sneak a
 * wider regen.
 *
 * Authed. Rate-limited at 20/min/IP. Both source + mask URLs are
 * SSRF-checked before round-tripping to Kie.
 */

interface EditRequestBody {
  originalImageUrl?: string;
  prompt?: string;
  /** New picker id from `EDIT_OPTIONS`. Replaces the old `model` field. */
  optionId?: string;
  /**
   * Deprecated. Kept so existing clients (the production-doc page and
   * shot editor before they're upgraded) keep working. Maps:
   *   - `nano-banana-edit`     → optionId `nano-banana-edit`
   *   - `gpt-4o-image-edit`    → optionId `gpt-4o-{quality}`
   */
  model?: string;
  mask?: { url?: string; quality?: 'low' | 'medium' | 'high' };
  /**
   * `'erase'` overrides the option + prompt: the route picks the
   * configured Erase backend and uses `ERASE_PROMPT`. The client just
   * needs to send `originalImageUrl` + `mask.url`.
   */
  intent?: 'edit' | 'erase';
  /** Override the default Erase backend per-request (settings layer
   *  reads/writes user preference; the client passes it through). */
  eraseOptionId?: string;
  /** Primary vendor for the GPT Image 2 edit dispatcher. Editor reads
   *  the user's localStorage setting and passes it through; the
   *  dispatcher falls back to the other vendor on failure. When
   *  absent, the route falls back to `UserSettings.gpt_image_2_edit_primary`
   *  from the database (for clients that haven't been upgraded to
   *  send this field), and ultimately to `'atlas'`. Only consulted
   *  when the resolved option's backend kind is `'atlas'`. See
   *  _plans/2026-05-29-gpt-image-2-edit-provider-fallback.md. */
  gptImage2EditPrimary?: 'atlas' | 'kie';
}

/** Pick the EditOption to dispatch for this request. Encapsulates the
 *  back-compat shim for the old `model` field plus the erase override. */
function resolveOption(body: EditRequestBody): { option: EditOption; reason: string } | { error: string } {
  if (body.intent === 'erase') {
    const id = (body.eraseOptionId as EditOptionId | undefined) || DEFAULT_ERASE_OPTION_ID;
    const opt = getEditOption(id);
    if (!opt) return { error: `Unknown erase backend: ${id}` };
    if (!opt.maskCapable) return { error: `Erase backend must be mask-capable: ${id}` };
    return { option: opt, reason: 'erase-intent' };
  }

  if (body.optionId) {
    const opt = getEditOption(body.optionId);
    if (!opt) return { error: `Unknown edit option: ${body.optionId}` };
    return { option: opt, reason: 'picker' };
  }

  // Back-compat: old `model` field.
  if (body.model === 'nano-banana-edit') {
    const opt = getEditOption('nano-banana-edit')!;
    return { option: opt, reason: 'legacy-model' };
  }
  if (body.model === 'gpt-4o-image-edit') {
    const q = body.mask?.quality ?? 'medium';
    const optId: EditOptionId = q === 'low' ? 'gpt-4o-low' : q === 'high' ? 'gpt-4o-high' : 'gpt-4o-medium';
    const opt = getEditOption(optId)!;
    return { option: opt, reason: 'legacy-model' };
  }

  // Default: cheapest prompt-only edit.
  return { option: getEditOption('nano-banana-edit')!, reason: 'default' };
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Tracks the provider_generations row id for the in-flight paid call.
  // Cleared after markDelivered (success) or markFailed (failure) lands
  // a terminal status. Same pattern as the main image route. See
  // _plans/2026-05-29-persistence-rebuild.md.
  let pendingIntentId: string | null = null;

  const { limited } = checkRateLimit(`prodoc-img-edit:${getClientIP(req)}`, 20, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: EditRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const resolved = resolveOption(body);
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const { option, reason: optionReason } = resolved;
  const isErase = body.intent === 'erase';

  const { originalImageUrl } = body;
  let prompt = isErase ? ERASE_PROMPT : (body.prompt ?? '').trim();

  if (!originalImageUrl?.trim()) {
    return NextResponse.json({ error: 'originalImageUrl required' }, { status: 400 });
  }
  if (!isErase && !prompt) {
    return NextResponse.json({ error: 'prompt required' }, { status: 400 });
  }
  // Truncate rather than 400 — production-doc rows persist the scene
  // body plus the chosen style's full suffix in `ai_image_prompt`, and
  // verbose-suffix styles (doodle_explainer_2 is ~1.9 kB) push the field
  // past 2000 chars on their own. Trimming the tail preserves the body
  // and the suffix's leading rules; for ref-bearing styles the refs
  // carry the visual style independently so the dropped suffix tail is
  // acceptable degradation. Symmetric with the main /image route.
  const PROMPT_CAP = 2000;
  if (!isErase && prompt.length > PROMPT_CAP) {
    const original = prompt.length;
    prompt = prompt.slice(0, PROMPT_CAP).replace(/\s+\S*$/, '').trimEnd();
    logger.info('[prodoc image-edit prompt-truncated]', {
      originalLen: original,
      truncatedLen: prompt.length,
    });
  }

  // SSRF guard on source image. Same comment as before: Kie does the
  // actual fetch server-to-server from their infra, but we reject
  // before the round-trip so it fails fast and doesn't bill us for a
  // doomed task.
  const sourceCheck = checkSafePublicUrl(originalImageUrl, { allowedProtocols: ['https:'] });
  if (!sourceCheck.ok) {
    return NextResponse.json({ error: `Source image: ${sourceCheck.error}` }, { status: 400 });
  }

  // Mask validation for mask-capable options. Both backends that need
  // a mask (kie-standard Ideogram, kie-gpt4o) require the same shape
  // — a public PNG matching the source's natural dimensions.
  let maskUrl: string | undefined;
  if (option.maskCapable) {
    if (!body.mask?.url) {
      return NextResponse.json(
        { error: `${option.label} requires a brush mask — paint a region first` },
        { status: 400 },
      );
    }
    const maskCheck = checkSafePublicUrl(body.mask.url, { allowedProtocols: ['https:'] });
    if (!maskCheck.ok) {
      return NextResponse.json({ error: `Mask URL: ${maskCheck.error}` }, { status: 400 });
    }
    maskUrl = body.mask.url;
  }

  // KIE_API_KEY is required for every existing backend (kie-standard,
  // kie-gpt4o, flux-kontext). The Atlas branch added 2026-05-25 needs
  // ATLAS_CLOUD_API_KEY instead, which generateAtlasEdit checks itself.
  // Gate the legacy check so an Atlas-only request doesn't 500 in
  // installs that haven't set KIE_API_KEY.
  const apiKey = process.env.KIE_API_KEY;
  if (option.backend.kind !== 'atlas' && !apiKey) {
    return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 });
  }

  console.info('[image-edit request]', {
    optionId: option.id,
    kind: option.backend.kind,
    optionReason,
    intent: body.intent ?? 'edit',
    hasMask: Boolean(maskUrl),
    promptLen: prompt.length,
  });

  // Audit-row BEFORE the paid provider call (Phase 1.0 of
  // _plans/2026-05-29-persistence-rebuild.md). Throws to short-circuit
  // if Postgres can't accept the row. provider is the backend kind
  // (kie-standard | kie-gpt4o | flux-kontext | atlas), providerModel
  // is the picker option id so we can group spend by option.
  const editIntent = await recordIntent({
    userId: session.uid,
    workspaceId: session.ws,
    route: '/api/generate/production-doc/image/edit',
    provider: option.backend.kind === 'atlas' ? 'atlas' : 'kie',
    providerModel: option.id,
  });
  pendingIntentId = editIntent.id;

  try {
    const taskStart = Date.now();
    let resultUrl: string;
    // Captured per-branch; fed into markDelivered so the provider's
    // billing dashboard can be cross-referenced from a single row.
    let providerRequestId: string | null = null;
    // Default to the catalog's static `pricePerImage`. The `atlas`
    // branch (now routed through generateGptImage2Edit's fallback
    // dispatcher) may override this with the per-vendor cost that
    // actually applied — Atlas $0.011 vs Kie $0.05 — so the audit row
    // reflects the real spend instead of the catalog estimate.
    let actualCostUsd: number | null = option.pricePerImage;

    switch (option.backend.kind) {
      case 'kie-standard': {
        const input = buildKieStandardInput(option, prompt, originalImageUrl, maskUrl);
        const taskId = await createKieTask(apiKey!, option.backend.kieModel, input);
        providerRequestId = taskId;
        console.info('[image-edit task]', { taskId, optionId: option.id, kind: 'kie-standard' });
        // System-wide auto-upscale runs after poll (skips if output is
        // already >2000px on the long edge — common for edits of
        // previously-upscaled images). See src/lib/upscale.ts.
        resultUrl = await pollKieResultThenUpscale(taskId, apiKey!);
        break;
      }
      case 'kie-gpt4o': {
        // GPT-4o image edit. The endpoint only accepts 1:1 / 3:2 / 2:3
        // — 3:2 is the closest match to the 16:9 production-doc target,
        // and the renderer crops to 16:9 at compose time anyway.
        const taskId = await createGpt4oImageTask(apiKey!, {
          prompt,
          filesUrl: [originalImageUrl],
          maskUrl,
          size: '3:2',
          quality: option.backend.quality,
        });
        providerRequestId = taskId;
        console.info('[image-edit task]', { taskId, optionId: option.id, kind: 'kie-gpt4o' });
        // System-wide auto-upscale: see src/lib/upscale.ts.
        resultUrl = await pollGpt4oImageResultThenUpscale(taskId, apiKey!);
        break;
      }
      case 'flux-kontext': {
        const taskId = await createFluxKontextTask(apiKey!, {
          prompt,
          inputImage: originalImageUrl,
          model: option.backend.kieModel,
          aspectRatio: '16:9',
          outputFormat: 'png',
        });
        providerRequestId = taskId;
        console.info('[image-edit task]', { taskId, optionId: option.id, kind: 'flux-kontext' });
        // System-wide auto-upscale: see src/lib/upscale.ts.
        resultUrl = await pollFluxKontextResultThenUpscale(taskId, apiKey!);
        break;
      }
      case 'atlas': {
        // GPT Image 2 Edit — routed through the vendor-agnostic
        // dispatcher (`generateGptImage2Edit`) which reads the user's
        // primary preference (`gpt_image_2_edit_primary`) and falls
        // back to the other vendor automatically on failure. Both
        // vendors (Atlas Cloud Edit, Kie i2i) deliver a 16:9 image at
        // ~1K — the dispatcher absorbs Atlas's 1536×1024 → 1536×864
        // crop step internally so this branch stays agnostic. See
        // _plans/2026-05-29-gpt-image-2-edit-provider-fallback.md.
        //
        // Mask handling: neither Atlas Edit nor Kie i2i exposes a
        // mask field — the catalog row carries `maskCapable: false`
        // and the mask validation above only fires when true.
        //
        // Foundation telemetry (Stage 0). The edit route doesn't know
        // the active style — variants come from `composeVariantEditRequest`
        // which composes against the base row's style upstream. ref_count
        // is 1 (the single input image); ref_ids is empty because the
        // input isn't a style ref row. Plan:
        // _plans/2026-05-27-doodle-explainer-2-foundation.md.
        logger.info('[prodoc image-gen telemetry]', {
          prompt_version: PROMPT_VERSION,
          style_id: null,
          style_version: null,
          ref_count: 1,
          ref_ids: [],
          suffix_chars: 0,
          prompt_chars: prompt.length,
          flag_short_variant: isShortVariantPromptEnabled(),
          flag_trimmed_suffix: isTrimmedSuffixEnabled(),
        } satisfies ImageGenTelemetry);
        // Resolution order for the dispatcher's primary vendor:
        //   1. request body (`gptImage2EditPrimary`) — client-side
        //      localStorage propagated through. Highest priority
        //      because it reflects the most recent user choice.
        //   2. `UserSettings.gpt_image_2_edit_primary` — server-synced
        //      setting (when Phase 3.1 mutate() outbox writes through).
        //      Catches clients that haven't been upgraded to send the
        //      body field.
        //   3. `'atlas'` — cost-optimal default.
        let primary: 'atlas' | 'kie' = body.gptImage2EditPrimary ?? 'atlas';
        if (!body.gptImage2EditPrimary) {
          const settings = await getUserSettings(session.uid);
          primary = settings.gpt_image_2_edit_primary ?? 'atlas';
        }
        const dispatched = await generateGptImage2Edit({
          prompt,
          sourceImageUrl: originalImageUrl,
          primary,
        });
        providerRequestId = dispatched.providerRequestId;
        console.info('[image-edit task]', {
          predictionId: dispatched.providerRequestId,
          optionId: option.id,
          kind: 'gpt2-edit',
          vendorUsed: dispatched.vendorUsed,
          fallbackUsed: dispatched.fallbackUsed,
          durationMs: dispatched.durationMs,
          costUsd: dispatched.costUsd,
        });
        const upscale = await upscaleViaRecraft(dispatched.url);
        resultUrl = upscale.url;
        // Per-call cost reflects the vendor that actually served, not
        // the catalog row's static `pricePerImage`. The audit row's
        // `provider` field still says 'atlas' from the upstream
        // recordIntent call — that's a known minor mis-attribution
        // when the fallback fires; the cost dashboard's spend total
        // remains accurate because actualCostUsd is honest.
        actualCostUsd = dispatched.costUsd;
        break;
      }
    }

    console.info('[image-edit done]', {
      optionId: option.id,
      durationMs: Date.now() - taskStart,
    });

    // Mirror to R2 + compute saliency. Both fail-soft: a mirror failure
    // falls back to Kie's CDN URL (still usable until upstream retention
    // expires), and a saliency failure leaves the row's overlay
    // resolution unchanged.
    let imageUrl = resultUrl;
    let imageBuffer: Buffer | null = null;
    try {
      const imgRes = await fetch(resultUrl);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        imageBuffer = buffer;
        const ext = contentType.includes('png') ? 'png' : 'jpg';
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `prodoc-images/${Date.now()}-edit-${randomSuffix}.${ext}`;
        await uploadToBucket(bucket, r2Key, buffer, contentType);
        imageUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
        console.info('[image-edit mirror]', { r2Key, ok: true });
      }
    } catch (uploadErr) {
      logger.warn('[image-edit] R2 mirror failed, falling back to Kie URL', {
        detail: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
      });
    }

    void markDelivered({
      id: editIntent.id,
      providerRequestId,
      responseUrl: imageUrl,
      costUsd: actualCostUsd,
      durationMs: Date.now() - taskStart,
    });
    pendingIntentId = null;

    const saliency = imageBuffer ? await computeImageSaliency(imageBuffer) : null;
    console.info('[image-edit saliency]', { ok: Boolean(saliency) });
    return NextResponse.json({ imageUrl, saliency, optionId: option.id });
  } catch (err) {
    if (pendingIntentId) {
      void markFailed({
        id: pendingIntentId,
        failureReason: err instanceof Error ? err.message : String(err),
      });
    }
    logger.error('Production-doc image edit failed', {
      detail: err instanceof Error ? err.message : String(err),
      optionId: option.id,
      promptLength: prompt.length,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Edit failed' },
      { status: 500 },
    );
  }
});

/**
 * Build the input payload for the kie-standard `createTask` endpoint.
 * Per-model field names diverge — Ideogram uses `image_url` (singular)
 * + `mask_url`, the others use `image_urls` (plural). Seedream 4.5 has
 * `quality: 'basic' | 'high'`, Seedream v4 has `image_resolution`, etc.
 * Each branch follows the kie.ai docs page for its model exactly.
 */
function buildKieStandardInput(
  option: EditOption,
  prompt: string,
  imageUrl: string,
  maskUrl: string | undefined,
): Record<string, unknown> {
  if (option.backend.kind !== 'kie-standard') {
    throw new Error('buildKieStandardInput called for non-standard backend');
  }
  const model = option.backend.kieModel;

  if (model === 'google/nano-banana-edit') {
    return {
      prompt,
      image_urls: [imageUrl],
      image_size: '16:9',
      output_format: 'png',
    };
  }
  if (model === 'qwen/image-edit') {
    return {
      prompt,
      image_url: imageUrl,
      image_size: 'landscape_16_9',
      output_format: 'png',
    };
  }
  if (model === 'qwen2/image-edit') {
    return {
      prompt,
      image_url: imageUrl,
      image_size: '16:9',
      output_format: 'png',
    };
  }
  if (model === 'seedream/4.5-edit') {
    // The picker exposes two siblings (basic / high). Their backend
    // ids differ in the option id only — read the suffix to pick the
    // quality field.
    const quality = option.id === 'seedream-4.5-high' ? 'high' : 'basic';
    return {
      prompt,
      image_urls: [imageUrl],
      aspect_ratio: '16:9',
      quality,
    };
  }
  if (model === 'bytedance/seedream-v4-edit') {
    // Seedream v4's `image_size` enum uses the `landscape_X_Y` /
    // `portrait_X_Y` notation, not the bare `'16:9'` string the other
    // models accept. Sending '16:9' here fails with a validation
    // error. Verified against the kie.ai docs OpenAPI spec on
    // 2026-05-23.
    return {
      prompt,
      image_urls: [imageUrl],
      image_size: 'landscape_16_9',
      image_resolution: '2K',
      max_images: 1,
    };
  }
  if (model === 'ideogram/v3-edit') {
    if (!maskUrl) {
      throw new Error('Ideogram v3-edit requires mask_url');
    }
    const speed =
      option.id === 'ideogram-v3-turbo' ? 'TURBO'
      : option.id === 'ideogram-v3-quality' ? 'QUALITY'
      : 'BALANCED';
    return {
      prompt,
      image_url: imageUrl,
      mask_url: maskUrl,
      rendering_speed: speed,
      expand_prompt: true,
    };
  }
  throw new Error(`No input builder for Kie model: ${model}`);
}

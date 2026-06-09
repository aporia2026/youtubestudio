/**
 * Vendor-agnostic base-frame text-to-image dispatcher for Shorts.
 *
 * Originally Phase 15.15 (4 portrait-verified models). Expanded
 * 2026-06-10 to ten cloud T2I models per the picker-expansion ask in
 * `_plans/2026-06-09-bulk-shorts-robustness-and-inspector.md` §8. The
 * full list now lives in `BASE_T2I_MODELS` (see
 * `shorts-base-t2i-types.ts`) — broadly grouped:
 *
 *   - OpenAI GPT Image 2 (atlas-gpt-image-2, kie-gpt-image-2)
 *   - Google Gemini 3.1 Flash Image (kie-nano-banana-2)
 *   - Black Forest Labs Flux 2 (kie-flux-2-pro, kie-flux-2-flex)
 *   - xAI Grok Imagine (kie-grok-imagine)
 *   - Ideogram v3 (kie-ideogram-v3-quality, kie-ideogram-v3-turbo)
 *   - Alibaba Qwen Image (kie-qwen-image)
 *   - ByteDance Seedream v4 (kie-seedream-v4)
 *
 * Aspect handling: every output is funnelled through
 * `cropToAspectAndUpload(_, _, 9, 16)` regardless of vendor or
 * native size. Each Kie branch tries to ask the model for portrait
 * up front (`aspect_ratio: '9:16'` or `image_size: 'portrait_16_9'`),
 * but if a model rejects the value, returns a different aspect, or
 * the docs are wrong, the crop pass produces exact 9:16 output. The
 * earlier "don't ship unverified portrait support" caveat is now
 * obsolete — the crop is the safety net.
 *
 * Failure posture: throws plain Error with the vendor message
 * preserved. No automatic vendor fallback — the user-picked model is
 * the user's choice; surfacing the failure is honest and lets them
 * pick another model on retry. The shorts-batch orchestrator's
 * retry-on-transient layer (see `shorts-batch-retry.ts`) handles
 * 5xx blips for both Atlas and Kie branches uniformly.
 *
 * Observability (rule 14): every call emits namespaced
 * `[shorts base-t2i]` lines covering dispatcher entry, model branch,
 * predictionId/taskId, durationMs, and costUsd.
 *
 * 16:9 vs 9:16: the production-doc surface uses the existing
 * `buildKieImageInput` helper which hard-codes landscape. We
 * deliberately do NOT call that helper here — Shorts needs portrait
 * and the helper is shared. The Kie branches build the input shape
 * inline so a future production-doc change doesn't accidentally flip
 * the Shorts pipeline to landscape.
 */

import { logger } from './logger';
import { generateAtlasT2I } from './atlas-cloud-images';
import { cropToAspectAndUpload } from './image-gen-dispatch';
import { createKieTask, pollKieResult } from './kie-poll';

/** R2 prefix for the 9:16-cropped Atlas T2I intermediate. Lives under
 *  its own key so storage metrics can show how often the crop path runs
 *  vs. the Kie native-9:16 path. */
const ATLAS_BASE_CROP_PREFIX = 'shorts-base-atlas-crop';

/** R2 prefix for the 9:16-cropped Kie T2I intermediate. Every Kie
 *  branch flows its output through cropToAspectAndUpload so we end up
 *  with exact 9:16 even when the model produced 1:1 / square / 16:9
 *  (e.g. Ideogram's `image_size` enum doesn't carry a documented
 *  portrait variant for every tier; rather than fail when the docs
 *  drift, we always crop). When the source already matches 9:16 the
 *  crop is a near no-op (re-encode + re-upload). */
const KIE_BASE_CROP_PREFIX = 'shorts-base-kie-crop';

// The model registry + types + resolver live in `./shorts-base-t2i-types.ts`
// so client components (the batch RetryAssetsPicker, the editor's
// base-model picker) can import them without dragging this server-only
// module's transitive sharp/atlas/kie deps into the browser bundle.
// Re-exported here so existing server-side callers keep their imports.
export {
  BASE_T2I_MODELS,
  DEFAULT_BASE_T2I_MODEL_ID,
  getBaseT2iModelSpec,
  resolveBaseT2iModelId,
  type ShortsBaseT2iModelId,
  type ShortsBaseT2iModelSpec,
} from './shorts-base-t2i-types';
import { getBaseT2iModelSpec, type ShortsBaseT2iModelId } from './shorts-base-t2i-types';

export interface GenerateShortsBaseT2iOpts {
  prompt: string;
  modelId: ShortsBaseT2iModelId;
}

export interface GenerateShortsBaseT2iResult {
  url: string;
  modelId: ShortsBaseT2iModelId;
  vendorUsed: 'atlas' | 'kie';
  costUsd: number;
  durationMs: number;
  providerRequestId: string | null;
}

/** Dispatch a single base-frame T2I call per the user-picked model.
 *  Routes Atlas → `generateAtlasT2I`; routes Kie → `createKieTask` +
 *  `pollKieResult` with a per-model input shape (each model takes
 *  slightly different fields).
 *
 *  No vendor fallback — the user picked a specific model; an Atlas
 *  outage shouldn't silently bill Kie. The caller surfaces the error
 *  in the progress strip so the user can pick a different model on
 *  retry. */
export async function generateShortsBaseT2I(
  opts: GenerateShortsBaseT2iOpts,
): Promise<GenerateShortsBaseT2iResult> {
  const t0 = Date.now();
  const spec = getBaseT2iModelSpec(opts.modelId);
  logger.info('[shorts base-t2i] dispatch start', {
    modelId: spec.id,
    vendor: spec.vendor,
    modelSlug: spec.modelSlug,
    promptChars: opts.prompt.length,
  });

  if (spec.vendor === 'atlas') {
    // Atlas's GPT Image 2 size enum doesn't include 9:16 — the closest
    // portrait is 1024×1536 (2:3). We request that, then center-crop to
    // 9:16 (864×1536) so the renderer's `object-fit: cover` is a
    // no-op instead of trimming ~11% of the composition. The prompt
    // already pushes the subject to the middle 60% so the trimmed
    // ~16% of width is dead space.
    const result = await generateAtlasT2I({
      prompt: opts.prompt,
      size: '1024x1536',
      quality: 'high',
    });
    const croppedUrl = await cropToAspectAndUpload(
      result.url,
      ATLAS_BASE_CROP_PREFIX,
      9,
      16,
    );
    const durationMs = Date.now() - t0;
    logger.info('[shorts base-t2i] atlas done', {
      modelId: spec.id,
      predictionId: result.predictionId,
      predictTimeMs: result.predictTimeMs,
      durationMs,
      costUsd: spec.costUsd,
      cropped_to_aspect: '9:16',
    });
    return {
      url: croppedUrl,
      modelId: spec.id,
      vendorUsed: 'atlas',
      costUsd: spec.costUsd,
      durationMs,
      providerRequestId: result.predictionId,
    };
  }

  // Kie branches. Build the per-model input shape inline to avoid
  // coupling to `buildKieImageInput` which is landscape-only.
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'KIE_API_KEY is not set — cannot dispatch Kie-hosted T2I. Pick Atlas GPT Image 2 instead.',
    );
  }

  const input: Record<string, unknown> = { prompt: opts.prompt };
  switch (spec.id) {
    case 'kie-gpt-image-2':
      // GPT Image 2 (Kie route). Accepts 9:16 / 2:3 / etc. We pin 9:16
      // to match the renderer's portrait composition.
      input.aspect_ratio = '9:16';
      input.resolution = '1K';
      break;
    case 'kie-nano-banana-2':
      // Nano Banana 2: aspect_ratio + optional resolution; we pin both
      // explicitly so a default change on Kie's end doesn't drift us.
      input.aspect_ratio = '9:16';
      input.resolution = '1K';
      input.output_format = 'png';
      break;
    case 'kie-flux-2-pro':
    case 'kie-flux-2-flex':
      // Flux 2 family: aspect_ratio + resolution. Both Pro and Flex
      // share the same input shape (only modelSlug differs).
      input.aspect_ratio = '9:16';
      input.resolution = '1K';
      break;
    case 'kie-grok-imagine':
      // Grok Imagine T2I. The Kie docs page for this exact endpoint
      // wasn't surfaced in the 2026-06-10 verification pass — the only
      // documented Grok endpoints were `image-to-image` and
      // `text-to-video`. The slug `grok-imagine/text-to-image` is
      // carried over from the production-doc registry where it has
      // been running. If Kie returns a non-portrait aspect, the crop
      // pass below trims it to exact 9:16. Send only the prompt to
      // avoid 422-ing on undocumented fields.
      break;
    case 'kie-ideogram-v3-quality':
    case 'kie-ideogram-v3-turbo':
      // Ideogram v3 — single model slug, tier carried in
      // `rendering_speed`. `portrait_16_9` is documented as a valid
      // `image_size` enum value (alongside square, square_hd,
      // portrait_4_3, landscape_4_3, landscape_16_9). The crop pass
      // is a no-op when source is already 9:16; safety net if the
      // enum string is ever rejected.
      input.image_size = 'portrait_16_9';
      input.rendering_speed = spec.id === 'kie-ideogram-v3-turbo' ? 'TURBO' : 'QUALITY';
      input.style = 'AUTO';
      input.expand_prompt = true;
      break;
    case 'kie-qwen-image':
      // Qwen image_size enum follows the `<orientation>_<a_b>`
      // convention; `portrait_16_9` is the symmetric counterpart of
      // the documented `landscape_16_9`. If the enum is rejected, the
      // crop pass salvages whatever Kie returned.
      input.image_size = 'portrait_16_9';
      input.output_format = 'png';
      input.enable_safety_checker = false;
      break;
    case 'kie-seedream-v4':
      // Seedream v4 T2I. Uses image_size + image_resolution per the
      // 2026-06-10 docs.kie.ai pass. Docs example shows `square_hd`;
      // the portrait variant follows the same naming convention.
      input.image_size = 'portrait_16_9';
      input.image_resolution = '1K';
      input.max_images = 1;
      input.nsfw_checker = false;
      break;
  }

  const taskId = await createKieTask(apiKey, spec.modelSlug, input);
  const rawUrl = await pollKieResult(taskId, apiKey);
  const generationMs = Date.now() - t0;
  // Always crop to exact 9:16 — see KIE_BASE_CROP_PREFIX comment for
  // the rationale. No-op when source is already 9:16.
  const url = await cropToAspectAndUpload(rawUrl, KIE_BASE_CROP_PREFIX, 9, 16);
  const durationMs = Date.now() - t0;
  logger.info('[shorts base-t2i] kie done', {
    modelId: spec.id,
    modelSlug: spec.modelSlug,
    taskId,
    generationMs,
    cropMs: durationMs - generationMs,
    durationMs,
    costUsd: spec.costUsd,
    cropped_to_aspect: '9:16',
  });
  return {
    url,
    modelId: spec.id,
    vendorUsed: 'kie',
    costUsd: spec.costUsd,
    durationMs,
    providerRequestId: taskId,
  };
}

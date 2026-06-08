/**
 * Vendor-agnostic base-frame text-to-image dispatcher for Shorts.
 *
 * Phase 15.15 — gives the user real model variety for the BASE frame
 * (the foundation that every variant is edited off). Routes to one of
 * four portrait-9:16-capable models:
 *
 *   - atlas-gpt-image-2 — Atlas Cloud's OpenAI GPT Image 2. ~$0.009/image.
 *                         Native 1024×1536 (2:3) portrait. Cost-optimal default.
 *   - kie-gpt-image-2   — Kie's GPT Image 2 (same OpenAI model, different
 *                         vendor). ~$0.05/image. Native 9:16. Kept for
 *                         parity with the variant vendor toggle so a
 *                         power user can pin the whole pipeline to Kie.
 *   - kie-nano-banana-2 — Kie's Gemini 3.1 Flash Image. ~$0.04/image.
 *                         Native 9:16. Different model — different
 *                         visual style than GPT Image 2.
 *   - kie-flux-2-pro    — Kie's Flux 2 Pro. ~$0.05/image. Native 9:16.
 *                         Different model — typically richer composition.
 *
 * Ideogram v3 is deliberately NOT in the registry: its kie.ai docs
 * page was auth-walled during the 2026-06-03 verification pass and we
 * couldn't confirm the `image_size` enum carries a portrait value.
 * Rule 1 (verify, don't guess) says don't ship the option.
 *
 * Failure posture: throws plain Error with the vendor message
 * preserved. No automatic vendor fallback — the user-picked model is
 * the user's choice; surfacing the failure is honest and lets them
 * pick another model on retry.
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
  if (spec.id === 'kie-gpt-image-2') {
    // GPT Image 2 (Kie route). Accepts 9:16 / 2:3 / etc. We pin 9:16
    // to match the renderer's portrait composition.
    input.aspect_ratio = '9:16';
    input.resolution = '1K';
  } else if (spec.id === 'kie-nano-banana-2') {
    // Nano Banana 2: aspect_ratio + optional resolution; we pin both
    // explicitly so a default change on Kie's end doesn't drift us.
    input.aspect_ratio = '9:16';
    input.resolution = '1K';
    input.output_format = 'png';
  } else if (spec.id === 'kie-flux-2-pro') {
    // Flux 2 Pro requires the resolution param per the docs.kie.ai
    // 2026-06-03 verification pass.
    input.aspect_ratio = '9:16';
    input.resolution = '1K';
  }

  const taskId = await createKieTask(apiKey, spec.modelSlug, input);
  const url = await pollKieResult(taskId, apiKey);
  const durationMs = Date.now() - t0;
  logger.info('[shorts base-t2i] kie done', {
    modelId: spec.id,
    modelSlug: spec.modelSlug,
    taskId,
    durationMs,
    costUsd: spec.costUsd,
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

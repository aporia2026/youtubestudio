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

/** The set of base T2I models exposed in the picker. Each entry is a
 *  string id; the dispatcher routes off this. Add new entries here AND
 *  in `BASE_T2I_MODELS` below; the picker UI reads from the same list. */
export type ShortsBaseT2iModelId =
  | 'atlas-gpt-image-2'
  | 'kie-gpt-image-2'
  | 'kie-nano-banana-2'
  | 'kie-flux-2-pro';

export interface ShortsBaseT2iModelSpec {
  id: ShortsBaseT2iModelId;
  /** Short display label for the dropdown. */
  label: string;
  /** Vendor identifier ('atlas' | 'kie'). */
  vendor: 'atlas' | 'kie';
  /** Flat per-call cost USD. Tracked locally because Kie's invoice
   *  arrives async; this is the audit-row estimate the caller logs. */
  costUsd: number;
  /** Underlying model id Kie / Atlas expects on the wire. */
  modelSlug: string;
  /** Short one-liner shown under the option to help the user pick. */
  hint: string;
}

export const BASE_T2I_MODELS: readonly ShortsBaseT2iModelSpec[] = Object.freeze([
  {
    id: 'atlas-gpt-image-2',
    label: 'Atlas GPT Image 2',
    vendor: 'atlas',
    costUsd: 0.009,
    modelSlug: 'openai/gpt-image-2/text-to-image',
    hint: 'Cost-optimal default. Same OpenAI model as Kie GPT-2 but cheaper.',
  },
  {
    id: 'kie-gpt-image-2',
    label: 'Kie GPT Image 2',
    vendor: 'kie',
    costUsd: 0.05,
    modelSlug: 'gpt-image-2-text-to-image',
    hint: 'Sibling of Atlas above (same OpenAI model, different vendor). 5× cost; kept for vendor parity.',
  },
  {
    id: 'kie-nano-banana-2',
    label: 'Nano Banana 2',
    vendor: 'kie',
    costUsd: 0.04,
    modelSlug: 'nano-banana-2',
    hint: 'Google Gemini 3.1 Flash Image — different visual style than GPT Image 2.',
  },
  {
    id: 'kie-flux-2-pro',
    label: 'Flux 2 Pro',
    vendor: 'kie',
    costUsd: 0.05,
    modelSlug: 'flux-2/pro-text-to-image',
    hint: 'Black Forest Labs Flux 2 — different model family, typically richer composition.',
  },
]);

export const DEFAULT_BASE_T2I_MODEL_ID: ShortsBaseT2iModelId = 'atlas-gpt-image-2';

/** Defensive resolver — narrows an arbitrary string to a valid model
 *  id, falling back to the cost-optimal default on bad input. Used by
 *  the route + UI layers so a stale localStorage value never crashes
 *  the dispatcher. */
export function resolveBaseT2iModelId(raw: unknown): ShortsBaseT2iModelId {
  if (typeof raw !== 'string') return DEFAULT_BASE_T2I_MODEL_ID;
  const match = BASE_T2I_MODELS.find((m) => m.id === raw);
  return match?.id ?? DEFAULT_BASE_T2I_MODEL_ID;
}

export function getBaseT2iModelSpec(id: ShortsBaseT2iModelId): ShortsBaseT2iModelSpec {
  // Non-null because the type union and BASE_T2I_MODELS are kept in
  // sync by construction. Throwing here would be load-bearing only if
  // someone bypassed the type system; the dispatcher would catch that
  // immediately on the wire-format mismatch.
  return BASE_T2I_MODELS.find((m) => m.id === id) ?? BASE_T2I_MODELS[0];
}

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

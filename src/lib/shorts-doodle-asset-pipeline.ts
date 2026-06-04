/**
 * Doodle vertical asset pipeline — Phase 15.3.
 *
 * Given a Short row and its caption chunks, generates the Doodle
 * Explainer 2 vertical render assets:
 *   1. ONE 1080×1920 BASE FRAME via Atlas Image (gpt-image-2-text-to-image
 *      with aspect_ratio=9:16). Composed with the Doodle Explainer 2 style
 *      suffix from `production-doc-styles.ts` so the visual language stays
 *      consistent with the long-form pipeline's doodle reference videos.
 *   2. N SIBLING-FRAME VARIANTS via Atlas Edit on the base frame. Each
 *      variant lines up with a caption-chunk transition; the renderer
 *      swaps frames at the chunk boundary.
 *
 * Cost: ~$0.04 (base) + ~$0.011 × N (variants). For 6 variants ≈ $0.11
 * per Short. Logged through the existing Atlas wrappers' ai_spend_log
 * integrations.
 *
 * The orchestrator stays pure-orchestration — no DB writes. The caller
 * (the API route) persists the returned shape into `shorts.style_assets`
 * and updates the row's `style_id` to `'doodle_explainer_2_short'`.
 *
 * Cost cap: hardcoded MAX_VARIANTS = 8 even when the AI returns more.
 * Mirrors the per-tick caps in the production-doc pipeline so a
 * runaway prompt can't burn 20 calls.
 */

import { logger } from './logger';
import { generateGptImage2Edit, type Gpt2EditVendor } from './gpt-image-2-edit';
import {
  DEFAULT_BASE_T2I_MODEL_ID,
  generateShortsBaseT2I,
  getBaseT2iModelSpec,
  type ShortsBaseT2iModelId,
} from './shorts-base-t2i';
import { generateText } from './ai';
import { type AiSpendContext } from './ai-spend';
import { getEffectiveModelId } from './model-defaults';
import { getBuiltInStyle } from './production-doc-styles';
import {
  buildDoodleVariantPrompt,
  parseDoodleVariantResult,
  type DoodleVariantResult,
} from './shorts-doodle-prompt';
import type { ShortCaptionChunk } from './shorts-render-types';
import type { GenerationProgressState } from './shorts-types';
import type { VariantPlanItem } from './shorts-asset-job';

const MAX_VARIANTS = 18;
// Per-model base-frame T2I lives in `shorts-base-t2i.ts`. The pipeline
// asks the dispatcher for the cost-optimal default unless the caller
// passes `baseT2iModelId`. Aspect handling moves into the dispatcher
// (Atlas takes 1024x1536; Kie family takes aspect_ratio: '9:16').

export interface DoodleAssetPipelineInput {
  workspaceId: string;
  projectId: string | null;
  shortId: string;
  /** The Short's spoken script body. */
  shortScript: string;
  hook?: string;
  payoff?: string;
  title?: string;
  niche: string;
  /** Pre-chunked captions from `splitScriptIntoCaptions`. The pipeline
   *  aligns variants to these chunk indices. */
  captions: ShortCaptionChunk[];
  /** Optional cap from the workspace setting / UI. Defaults to 6. */
  maxVariants?: number;
  /** Phase 15.14 — vendor for the variant Edit calls. Threads through
   *  to `generateGptImage2Edit`'s primary. Defaults to 'atlas' (the
   *  cost-optimal vendor). The route layer reads this from the user's
   *  `gpt_image_2_edit_primary` setting. */
  variantEditPrimary?: Gpt2EditVendor;
  /** Phase 15.15 — model for the base T2I call. Defaults to
   *  `DEFAULT_BASE_T2I_MODEL_ID` (atlas-gpt-image-2). The route reads
   *  this from `UserSettings.shorts_base_t2i_model_id`. */
  baseT2iModelId?: ShortsBaseT2iModelId;
  /** Phase 15.13 — per-step progress hook. The caller (the API route)
   *  implements this by writing to `shorts.generation_progress` so the
   *  editor's poll picks it up. Awaited so DB writes serialise with the
   *  pipeline's vendor calls instead of racing. Errors thrown from
   *  onProgress are caught + logged but do not fail the pipeline (the
   *  progress strip is observability, not a critical path). */
  onProgress?: (state: GenerationProgressState) => Promise<void> | void;
  /** Migration 0117 — creator-supplied prompt steer. See
   *  `DoodleVariantInput.assetsContext`. */
  assetsContext?: string;
}

export interface DoodleAssetPipelineResult {
  base_url: string;
  /** Phase 15.12 — full prompt that produced base_url. Stored so the
   *  Shots panel can show + re-edit it on per-frame regen. */
  base_prompt: string;
  variants: Array<{
    url: string;
    caption_chunk_start_index: number;
    /** Phase 15.12 — edit prompt that produced this variant. */
    edit_prompt: string;
  }>;
  /** Sum of the per-call cost USD logged to the spend log. Informational
   *  — the per-call entries are the source of truth. */
  estimatedCostUsd: number;
}

function buildBasePromptFull(scenePrompt: string): string {
  // Pull the long-form Doodle Explainer 2 style suffix so the visual
  // language matches the long-form pipeline. Falls back to a minimal
  // doodle description if the registry entry has been renamed/removed
  // (defensive — the user has a strong rule against silent breakage).
  const longFormStyle = getBuiltInStyle('doodle_explainer_2');
  const suffix =
    longFormStyle?.ai_image_suffix
    ?? 'Hand-drawn cartoon doodle in thin black ink outlines on a white background, stick-figure-style characters with light clothing detail. Slightly imperfect freehand lines.';
  // Force the vertical composition guidance up front so the model
  // commits the subject to the middle-60% safe zone even before reading
  // the style suffix.
  return `Vertical 9:16 composition. Subject placed in the middle 60% of the frame; top 10% and bottom 10% left intentionally empty for player UI / captions. ${scenePrompt} ${suffix}`;
}

/** Internal helper — fire onProgress without letting it kill the
 *  pipeline. The progress hook is observability; a bad DB write here
 *  should not lose us a $0.04 base + N × $0.011 variant run.
 *  Errors are logged to `[shorts doodle pipeline] progress hook
 *  failed` so the operator still sees them. */
async function safeProgress(
  cb: DoodleAssetPipelineInput['onProgress'],
  state: GenerationProgressState,
): Promise<void> {
  if (!cb) return;
  try {
    await cb(state);
  } catch (err) {
    logger.warn('[shorts doodle pipeline] progress hook failed', {
      phase: state.phase,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Decomposed pipeline steps (Phase 15.16) ──────────────────────────────
// The background cron drives these one bounded step per tick, persisting
// between them, so a slow/failed vendor leg never blows a 300s budget and
// completed work survives a tick death. Each step is pure work — no
// progress writes; the caller (cron, or the wrapper below) layers its own.

export interface PlanDoodleAssetsInput {
  workspaceId: string;
  projectId: string | null;
  shortId: string;
  shortScript: string;
  hook?: string;
  payoff?: string;
  title?: string;
  niche: string;
  captions: ShortCaptionChunk[];
  maxVariants?: number;
  /** Migration 0117 — creator-supplied prompt steer threaded through the
   *  planner. See `DoodleVariantInput.assetsContext`. */
  assetsContext?: string;
}

/** Step 1 — the LLM call that plans the base scene prompt + per-chunk
 *  variant edit prompts. Persisted by the cron so a re-tick never re-pays
 *  for it. `basePrompt` is the planner's raw scene description; the full
 *  T2I prompt (with style suffix) is built later in the base step. */
export async function planDoodleAssets(
  input: PlanDoodleAssetsInput,
): Promise<{ basePrompt: string; variantPlan: VariantPlanItem[] }> {
  const modelId = await getEffectiveModelId(input.workspaceId, 'shorts-doodle-prompt');
  const requestedMax = input.maxVariants ?? 6;
  const cappedMax = Math.min(MAX_VARIANTS, Math.max(1, requestedMax));
  const { system, user } = buildDoodleVariantPrompt({
    shortScript: input.shortScript,
    hook: input.hook,
    payoff: input.payoff,
    title: input.title,
    captions: input.captions,
    niche: input.niche,
    maxVariants: cappedMax,
    assetsContext: input.assetsContext,
  });
  const spend: AiSpendContext = {
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    featureArea: 'shorts_doodle_prompt',
    metadata: { short_id: input.shortId, requested_variants: cappedMax },
  };
  const raw = await generateText({
    modelId,
    systemPrompt: system,
    prompt: user,
    maxTokens: 2600,
    temperature: 0.65,
    spend,
  });
  let plan: DoodleVariantResult;
  try {
    plan = parseDoodleVariantResult(raw, input.captions.length);
  } catch (err) {
    logger.error('[shorts doodle pipeline] prompt parse failed', {
      shortId: input.shortId,
      detail: err instanceof Error ? err.message : String(err),
      raw_preview: raw.slice(0, 400),
    });
    throw new Error(
      `Doodle planner returned an unparseable response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Hard cap the variant count even if the model returned more.
  const variantPlan = plan.variants.slice(0, cappedMax);
  logger.info('[shorts doodle pipeline] planned', {
    shortId: input.shortId,
    basePromptChars: plan.base_prompt.length,
    variantCount: variantPlan.length,
    chunkIndexes: variantPlan.map((v) => v.caption_chunk_start_index),
  });
  return { basePrompt: plan.base_prompt, variantPlan };
}

/** Step 2 — render the 9:16 base frame from the planner's scene prompt.
 *  Returns the FULL prompt actually sent (scene + style suffix +
 *  composition guidance) so the caller can persist it for per-frame
 *  re-edit on `style_assets.doodle.base_prompt`. */
export async function generateDoodleBaseFrame(args: {
  basePrompt: string;
  baseT2iModelId?: ShortsBaseT2iModelId;
  shortId?: string;
}): Promise<{ baseUrl: string; basePromptFull: string; costUsd: number; modelId: string; vendorUsed: string }> {
  const baseModelId = args.baseT2iModelId ?? DEFAULT_BASE_T2I_MODEL_ID;
  const fullBasePrompt = buildBasePromptFull(args.basePrompt);
  const baseResult = await generateShortsBaseT2I({ prompt: fullBasePrompt, modelId: baseModelId });
  logger.info('[shorts doodle pipeline] base ready', {
    shortId: args.shortId,
    baseModelId: baseResult.modelId,
    baseVendor: baseResult.vendorUsed,
    providerRequestId: baseResult.providerRequestId,
    baseUrl: baseResult.url,
    baseDurationMs: baseResult.durationMs,
  });
  return {
    baseUrl: baseResult.url,
    basePromptFull: fullBasePrompt,
    costUsd: baseResult.costUsd,
    modelId: baseResult.modelId,
    vendorUsed: baseResult.vendorUsed,
  };
}

/** Step 3 — one variant edit off the base frame. Throws on failure so the
 *  caller decides whether to retry (next tick) or skip (partial success). */
export async function generateDoodleVariantFrame(args: {
  baseUrl: string;
  item: VariantPlanItem;
  variantEditPrimary?: Gpt2EditVendor;
  shortId?: string;
}): Promise<{
  url: string;
  caption_chunk_start_index: number;
  edit_prompt: string;
  costUsd: number;
  vendorUsed: Gpt2EditVendor;
  fallbackUsed: boolean;
}> {
  const result = await generateGptImage2Edit({
    prompt: args.item.edit_prompt,
    sourceImageUrl: args.baseUrl,
    primary: args.variantEditPrimary ?? 'atlas',
  });
  logger.info('[shorts doodle pipeline] variant ready', {
    shortId: args.shortId,
    chunkIndex: args.item.caption_chunk_start_index,
    vendorUsed: result.vendorUsed,
    fallbackUsed: result.fallbackUsed,
    costUsd: result.costUsd,
    url: result.url,
  });
  return {
    url: result.url,
    caption_chunk_start_index: args.item.caption_chunk_start_index,
    edit_prompt: args.item.edit_prompt,
    costUsd: result.costUsd,
    vendorUsed: result.vendorUsed,
    fallbackUsed: result.fallbackUsed,
  };
}

/**
 * All-in-one sequential pipeline — kept as the back-compat entry point
 * (the legacy synchronous route + the progress-contract tests use it). The
 * background cron does NOT call this; it drives the three steps above with
 * its own parallelism + incremental persistence. This wrapper composes the
 * steps sequentially and preserves the planning → base → variant(1..N)
 * onProgress event order.
 */
export async function generateDoodleAssets(
  input: DoodleAssetPipelineInput,
): Promise<DoodleAssetPipelineResult> {
  const tStart = Date.now();
  logger.info('[shorts doodle pipeline] start', {
    workspaceId: input.workspaceId,
    shortId: input.shortId,
    captionCount: input.captions.length,
    requestedVariants: input.maxVariants,
  });

  await safeProgress(input.onProgress, {
    phase: 'planning',
    label: 'Planning base + variant prompts…',
    style_id: 'doodle_explainer_2_short',
  });
  const { basePrompt, variantPlan } = await planDoodleAssets(input);

  const baseSpec = getBaseT2iModelSpec(input.baseT2iModelId ?? DEFAULT_BASE_T2I_MODEL_ID);
  await safeProgress(input.onProgress, {
    phase: 'base',
    label: `Generating base frame (${baseSpec.label}, ~30-60s)…`,
    style_id: 'doodle_explainer_2_short',
    total: variantPlan.length,
  });
  const base = await generateDoodleBaseFrame({
    basePrompt,
    baseT2iModelId: input.baseT2iModelId,
    shortId: input.shortId,
  });

  const variants: DoodleAssetPipelineResult['variants'] = [];
  let estimatedCostUsd = base.costUsd;
  for (let i = 0; i < variantPlan.length; i++) {
    const v = variantPlan[i];
    await safeProgress(input.onProgress, {
      phase: 'variant',
      current: i + 1,
      total: variantPlan.length,
      label: `Generating variant ${i + 1} of ${variantPlan.length} (Atlas Edit, ~15-25s)…`,
      style_id: 'doodle_explainer_2_short',
    });
    try {
      const result = await generateDoodleVariantFrame({
        baseUrl: base.baseUrl,
        item: v,
        variantEditPrimary: input.variantEditPrimary,
        shortId: input.shortId,
      });
      variants.push({
        url: result.url,
        caption_chunk_start_index: result.caption_chunk_start_index,
        edit_prompt: result.edit_prompt,
      });
      estimatedCostUsd += result.costUsd;
    } catch (err) {
      logger.warn('[shorts doodle pipeline] variant failed (skipping)', {
        shortId: input.shortId,
        chunkIndex: v.caption_chunk_start_index,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (variants.length === 0) {
    throw new Error(
      'Doodle variant pipeline produced zero variants — every Atlas Edit call failed. Retry later or check ATLAS_API_KEY.',
    );
  }

  logger.info('[shorts doodle pipeline] done', {
    shortId: input.shortId,
    baseUrl: base.baseUrl,
    variantCount: variants.length,
    estimatedCostUsd,
    totalDurationMs: Date.now() - tStart,
  });

  return {
    base_url: base.baseUrl,
    base_prompt: base.basePromptFull,
    variants,
    estimatedCostUsd,
  };
}

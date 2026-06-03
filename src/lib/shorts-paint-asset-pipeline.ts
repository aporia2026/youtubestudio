/**
 * Paint Explainer V1 vertical asset pipeline — Phase 15.4 (v1).
 *
 * Mirrors `shorts-doodle-asset-pipeline.ts` shape but uses the long-form
 * `paint_explainer_v1` style suffix instead of `doodle_explainer_2`. The
 * prompt planner is shared (`shorts-doodle-prompt.ts`) because the
 * input-output contract — base scene + N sibling-variant edit prompts —
 * is identical across both styles.
 *
 * v1 limitation honestly flagged on the ROADMAP entry: the full motion-
 * component port (MouthSwap, PropSlideIn, MicroWiggle, ScribbleDraw,
 * LabelPopOn, RealPhotoPunchIn — see src/remotion/components/) is NOT
 * included. That's Phase 15.4.B. v1 ships the visual language via the
 * sibling-frame mechanism (per the user's memory: "near-static = Atlas
 * Edit variants, NEVER Remotion motion on a static image").
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

const MAX_VARIANTS = 8;
// Per-model base-frame T2I handled by `shorts-base-t2i.ts`. See the
// doodle pipeline for the rationale; the paint pipeline mirrors it.

export interface PaintAssetPipelineInput {
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
  /** Phase 15.14 — vendor for the variant Edit calls. Mirrors the
   *  doodle pipeline; see its docstring. */
  variantEditPrimary?: Gpt2EditVendor;
  /** Phase 15.15 — model for the base T2I call. Mirrors the doodle
   *  pipeline; see its docstring. */
  baseT2iModelId?: ShortsBaseT2iModelId;
  /** Phase 15.13 — per-step progress hook. Same contract as the Doodle
   *  pipeline; see `shorts-doodle-asset-pipeline.ts` for the rationale. */
  onProgress?: (state: GenerationProgressState) => Promise<void> | void;
}

export interface PaintAssetPipelineResult {
  base_url: string;
  base_prompt: string;
  variants: Array<{
    url: string;
    caption_chunk_start_index: number;
    edit_prompt: string;
  }>;
  estimatedCostUsd: number;
}

function buildBasePromptFull(scenePrompt: string): string {
  // Pull the long-form Paint Explainer V1 style suffix so the visual
  // language matches the long-form reference videos. Fallback covers
  // the rare case where the long-form registry entry is renamed.
  const longFormStyle = getBuiltInStyle('paint_explainer_v1');
  const suffix =
    longFormStyle?.ai_image_suffix
    ?? 'Hand-drawn doodle in the Paint Explainer style — pure white canvas, thick uneven black ink outlines, flat fills only, stick-figure character anatomy, generous negative space.';
  // Force the vertical composition guidance up front so the model
  // commits the subject to the middle-60% safe zone.
  return `Vertical 9:16 composition. Subject placed in the middle 60% of the frame; top 10% and bottom 10% left intentionally empty for player UI / captions. ${scenePrompt} ${suffix}`;
}

/** Mirror of `safeProgress` in shorts-doodle-asset-pipeline. Keeps
 *  observability writes from killing the paint pipeline mid-run. */
async function safeProgress(
  cb: PaintAssetPipelineInput['onProgress'],
  state: GenerationProgressState,
): Promise<void> {
  if (!cb) return;
  try {
    await cb(state);
  } catch (err) {
    logger.warn('[shorts paint pipeline] progress hook failed', {
      phase: state.phase,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function generatePaintAssets(
  input: PaintAssetPipelineInput,
): Promise<PaintAssetPipelineResult> {
  const tStart = Date.now();
  logger.info('[shorts paint pipeline] start', {
    workspaceId: input.workspaceId,
    shortId: input.shortId,
    captionCount: input.captions.length,
    requestedVariants: input.maxVariants,
  });

  await safeProgress(input.onProgress, {
    phase: 'planning',
    label: 'Planning base + variant prompts…',
    style_id: 'paint_explainer_v1_short',
  });

  // ---- 1. LLM call to plan base + variant prompts ------------------------
  // Reuses the Doodle prompt builder — same input-output contract.
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
  });
  const spend: AiSpendContext = {
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    featureArea: 'shorts_paint_prompt',
    metadata: { short_id: input.shortId, requested_variants: cappedMax },
  };
  const raw = await generateText({
    modelId,
    systemPrompt: system,
    prompt: user,
    maxTokens: 1600,
    temperature: 0.65,
    spend,
  });
  let plan: DoodleVariantResult;
  try {
    plan = parseDoodleVariantResult(raw, input.captions.length);
  } catch (err) {
    logger.error('[shorts paint pipeline] prompt parse failed', {
      shortId: input.shortId,
      detail: err instanceof Error ? err.message : String(err),
      raw_preview: raw.slice(0, 400),
    });
    throw new Error(
      `Paint planner returned an unparseable response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const variantPlan = plan.variants.slice(0, cappedMax);
  logger.info('[shorts paint pipeline] planned', {
    shortId: input.shortId,
    basePromptChars: plan.base_prompt.length,
    variantCount: variantPlan.length,
    chunkIndexes: variantPlan.map((v) => v.caption_chunk_start_index),
  });

  // ---- 2. Base T2I (user-picked model) ----------------------------------
  const baseModelId = input.baseT2iModelId ?? DEFAULT_BASE_T2I_MODEL_ID;
  const baseSpec = getBaseT2iModelSpec(baseModelId);
  await safeProgress(input.onProgress, {
    phase: 'base',
    label: `Generating base frame (${baseSpec.label}, ~30-60s)…`,
    style_id: 'paint_explainer_v1_short',
    total: variantPlan.length,
  });
  const fullBasePrompt = buildBasePromptFull(plan.base_prompt);
  const baseResult = await generateShortsBaseT2I({
    prompt: fullBasePrompt,
    modelId: baseModelId,
  });
  const baseUrl = baseResult.url;
  logger.info('[shorts paint pipeline] base ready', {
    shortId: input.shortId,
    baseModelId: baseResult.modelId,
    baseVendor: baseResult.vendorUsed,
    providerRequestId: baseResult.providerRequestId,
    baseUrl,
    baseDurationMs: baseResult.durationMs,
    durationMsSoFar: Date.now() - tStart,
  });

  // ---- 3. Atlas Edit (with Kie fallback) for each VARIANT ----------------
  const variants: PaintAssetPipelineResult['variants'] = [];
  let estimatedCostUsd = baseResult.costUsd;
  for (let i = 0; i < variantPlan.length; i++) {
    const v = variantPlan[i];
    await safeProgress(input.onProgress, {
      phase: 'variant',
      current: i + 1,
      total: variantPlan.length,
      label: `Generating variant ${i + 1} of ${variantPlan.length} (Atlas Edit, ~15-25s)…`,
      style_id: 'paint_explainer_v1_short',
    });
    try {
      const result = await generateGptImage2Edit({
        prompt: v.edit_prompt,
        sourceImageUrl: baseUrl,
        primary: input.variantEditPrimary ?? 'atlas',
      });
      variants.push({
        url: result.url,
        caption_chunk_start_index: v.caption_chunk_start_index,
        edit_prompt: v.edit_prompt,
      });
      estimatedCostUsd += result.costUsd;
      logger.info('[shorts paint pipeline] variant ready', {
        shortId: input.shortId,
        chunkIndex: v.caption_chunk_start_index,
        vendorUsed: result.vendorUsed,
        fallbackUsed: result.fallbackUsed,
        costUsd: result.costUsd,
        url: result.url,
      });
    } catch (err) {
      logger.warn('[shorts paint pipeline] variant failed (skipping)', {
        shortId: input.shortId,
        chunkIndex: v.caption_chunk_start_index,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (variants.length === 0) {
    throw new Error(
      'Paint variant pipeline produced zero variants — every Atlas Edit call failed. Retry later or check ATLAS_API_KEY.',
    );
  }

  logger.info('[shorts paint pipeline] done', {
    shortId: input.shortId,
    baseUrl,
    variantCount: variants.length,
    estimatedCostUsd,
    totalDurationMs: Date.now() - tStart,
  });

  return {
    base_url: baseUrl,
    base_prompt: fullBasePrompt,
    variants,
    estimatedCostUsd,
  };
}

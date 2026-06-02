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
import { generateAtlasT2I } from './atlas-cloud-images';
import { generateGptImage2Edit } from './gpt-image-2-edit';
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

const MAX_VARIANTS = 8;
// Atlas T2I supports four enum sizes: 1024x1024, 1024x1536, 1536x1024,
// 2560x1440. There is no native 1080x1920 — 1024x1536 (2:3, ~0.667
// aspect) is the closest portrait. The renderer uses `object-fit:
// cover` so 2:3 fits into 9:16 (0.5625) with a small horizontal crop;
// keeps the base + variants all at the same Atlas-native dimensions
// instead of forcing a stretch.
const VERTICAL_BASE_SIZE = '1024x1536';
const VERTICAL_QUALITY = 'high';
// Atlas T2I flat-rate per call (per atlas-cloud-images.ts; mirrors
// the audit-row accounting in the dispatcher).
const ATLAS_T2I_COST_USD = 0.04;

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

  // ---- 1. LLM call to plan base + variant prompts ------------------------
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
    featureArea: 'shorts_doodle_prompt',
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

  // ---- 2. Atlas Image t2i for the BASE frame -----------------------------
  const fullBasePrompt = buildBasePromptFull(plan.base_prompt);
  const baseResult = await generateAtlasT2I({
    prompt: fullBasePrompt,
    size: VERTICAL_BASE_SIZE,
    quality: VERTICAL_QUALITY,
  });
  const baseUrl = baseResult.url;
  logger.info('[shorts doodle pipeline] base ready', {
    shortId: input.shortId,
    basePredictionId: baseResult.predictionId,
    baseUrl,
    predictTimeMs: baseResult.predictTimeMs,
    durationMsSoFar: Date.now() - tStart,
  });

  // ---- 3. Atlas Edit (with Kie fallback) for each VARIANT ----------------
  const variants: DoodleAssetPipelineResult['variants'] = [];
  let estimatedCostUsd = ATLAS_T2I_COST_USD;
  for (const v of variantPlan) {
    try {
      const result = await generateGptImage2Edit({
        prompt: v.edit_prompt,
        sourceImageUrl: baseUrl,
        primary: 'atlas',
      });
      variants.push({
        url: result.url,
        caption_chunk_start_index: v.caption_chunk_start_index,
        edit_prompt: v.edit_prompt,
      });
      estimatedCostUsd += result.costUsd;
      logger.info('[shorts doodle pipeline] variant ready', {
        shortId: input.shortId,
        chunkIndex: v.caption_chunk_start_index,
        vendorUsed: result.vendorUsed,
        fallbackUsed: result.fallbackUsed,
        costUsd: result.costUsd,
        url: result.url,
      });
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

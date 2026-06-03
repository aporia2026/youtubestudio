/**
 * Per-frame ops for the Shots panel — Phase 15.12.
 *
 * The Shots panel in `ShortEditor` lets the user re-prompt + regenerate
 * individual frames (base + N variants) of a Doodle or Paint Short
 * without re-running the whole pipeline. This file owns the pure
 * orchestration:
 *   - regenerateBaseFrame   → new Atlas T2I, returns updated style_assets
 *   - regenerateVariantFrame → new Atlas Edit against the current base,
 *                              swaps the variant in place
 *   - appendVariantFrame    → new Atlas Edit, inserts a new variant
 *                              sorted by caption_chunk_start_index
 *   - deleteVariantFrame    → splices a variant out
 *
 * Each helper takes the current `ShortRow` and returns the new
 * `style_assets` JSON blob; the caller (the API route) is responsible
 * for persisting and gating on workspace ownership. Mirrors the
 * orchestrator/route split in `shorts-doodle-asset-pipeline.ts`.
 *
 * Style routing: the row's `style_id` decides which sub-block
 * (`style_assets.doodle` or `style_assets.paint`) we read+write. Both
 * sub-blocks share the same shape, so the ops are style-agnostic past
 * that lookup.
 *
 * Failure posture: throws plain `Error` with vendor message preserved.
 * The API route maps to a 5xx via `domainErrorResponse`. No silent
 * vendor fallback inside the frame ops — `generateGptImage2Edit`
 * already handles Atlas→Kie fallback at the vendor layer.
 *
 * Observability (rule 14): every op emits one `[shorts frame-ops X]
 * start` line and one `[shorts frame-ops X] done` line with the
 * relevant ids and durations. Vendor errors bubble up with their
 * existing namespaced logs from atlas-cloud-images + gpt-image-2-edit.
 */

import { logger } from './logger';
import { generateGptImage2Edit, type Gpt2EditVendor } from './gpt-image-2-edit';
import {
  DEFAULT_BASE_T2I_MODEL_ID,
  generateShortsBaseT2I,
  resolveBaseT2iModelId,
  type ShortsBaseT2iModelId,
} from './shorts-base-t2i';
import type { ShortRow, ShortStyleAssets } from './shorts-types';

/** The two styles whose `style_assets` carry a base+variants shape.
 *  `minimal_gradient_v1` has no assets so the Shots panel doesn't apply
 *  to it. */
type SupportedStyleKey = 'doodle' | 'paint';

interface FrameAssetsBlock {
  base_url: string;
  base_prompt?: string;
  variants: Array<{
    url: string;
    caption_chunk_start_index: number;
    edit_prompt?: string;
  }>;
}

/** Map a row's `style_id` to the `style_assets` sub-key it owns. Throws
 *  if the row is on a style without per-frame assets — the Shots panel
 *  hides itself in that case, but defense in depth keeps the route
 *  honest. */
function resolveStyleKey(row: ShortRow): SupportedStyleKey {
  if (row.style_id === 'doodle_explainer_2_short') return 'doodle';
  if (row.style_id === 'paint_explainer_v1_short') return 'paint';
  throw new Error(
    `Shots panel ops only apply to Doodle or Paint shorts (style_id="${row.style_id ?? 'null'}").`,
  );
}

/** Pull the existing block off the row, throwing if it's missing. Every
 *  frame op needs the prior block (base_url for edits, variants array
 *  for index targeting). A row on the Doodle style with no `doodle`
 *  block means the user never ran the asset pipeline — they need to
 *  click "Generate" before the Shots panel can do anything. */
function requireBlock(row: ShortRow, key: SupportedStyleKey): FrameAssetsBlock {
  const block = row.style_assets?.[key];
  if (!block) {
    throw new Error(
      `Shorts row has style_id="${row.style_id}" but no style_assets.${key} block yet — run Generate assets first.`,
    );
  }
  return block;
}

/** Replace one sub-block on the row's existing `style_assets` shape.
 *  Preserves the other sub-block (so a Short that's been edited under
 *  both styles keeps both). */
function mergeBlock(
  existing: ShortStyleAssets,
  key: SupportedStyleKey,
  block: FrameAssetsBlock,
): ShortStyleAssets {
  return { ...existing, [key]: block };
}

// ---------------------------------------------------------------------------
// 1. Regenerate base frame
// ---------------------------------------------------------------------------

export interface RegenerateBaseOptions {
  /** Full prompt to send to the chosen T2I model. The UI textarea is
   *  pre-populated with the previously stored `base_prompt` so the
   *  user can edit and resubmit verbatim. No style-suffix wrapping
   *  happens here — the stored prompt already includes the suffix
   *  from when the pipeline first generated it (see
   *  `buildBasePromptFull` in the pipelines). */
  prompt: string;
  /** Phase 15.15 — model to use for this call. Falls back to
   *  `DEFAULT_BASE_T2I_MODEL_ID` (atlas-gpt-image-2) when omitted.
   *  The route resolves precedence: body override > UserSettings
   *  > default. */
  modelId?: ShortsBaseT2iModelId;
}

export interface RegenerateBaseResult {
  style_assets: ShortStyleAssets;
  /** Per-model flat cost USD. The dispatcher tracks the value off the
   *  model spec — caller logs to ai_spend_log + surfaces in the UI. */
  costUsd: number;
  durationMs: number;
  /** Which model + vendor actually served the call. Useful for the
   *  route's persistence log and for surfacing in the UI strip. */
  modelId: ShortsBaseT2iModelId;
  vendorUsed: 'atlas' | 'kie';
}

/**
 * Regenerate the base frame for a Short. The N existing variants are
 * left in place — they still reference the OLD base_url in the sense
 * that they were edits off it, but the URLs themselves are R2-hosted
 * and don't break. The user can re-run individual variants after if
 * the new base diverges visually enough that the variants look off.
 *
 * Note that the variants array on the returned block is the same
 * reference as the input block's array — callers must not mutate it.
 */
export async function regenerateBaseFrame(
  row: ShortRow,
  opts: RegenerateBaseOptions,
): Promise<RegenerateBaseResult> {
  const tStart = Date.now();
  const key = resolveStyleKey(row);
  const prevBlock = requireBlock(row, key);
  const modelId = resolveBaseT2iModelId(opts.modelId ?? DEFAULT_BASE_T2I_MODEL_ID);

  console.info('[shorts frame-ops regenerate-base] start', {
    shortId: row.id,
    workspaceId: row.workspace_id,
    styleKey: key,
    modelId,
    promptChars: opts.prompt.length,
    prevBaseUrl: prevBlock.base_url,
    variantCount: prevBlock.variants.length,
  });

  const result = await generateShortsBaseT2I({
    prompt: opts.prompt,
    modelId,
  });

  const newBlock: FrameAssetsBlock = {
    base_url: result.url,
    base_prompt: opts.prompt,
    variants: prevBlock.variants,
  };
  const style_assets = mergeBlock(row.style_assets ?? {}, key, newBlock);
  const durationMs = Date.now() - tStart;

  logger.info('[shorts frame-ops regenerate-base] done', {
    shortId: row.id,
    styleKey: key,
    modelId: result.modelId,
    vendorUsed: result.vendorUsed,
    newBaseUrl: newBlock.base_url,
    providerRequestId: result.providerRequestId,
    costUsd: result.costUsd,
    durationMs,
  });

  return {
    style_assets,
    costUsd: result.costUsd,
    durationMs,
    modelId: result.modelId,
    vendorUsed: result.vendorUsed,
  };
}

// ---------------------------------------------------------------------------
// 2. Regenerate one variant frame
// ---------------------------------------------------------------------------

export interface RegenerateVariantOptions {
  /** Zero-based index into the existing `variants` array. */
  index: number;
  /** The new edit prompt. The UI pre-populates with the stored
   *  `edit_prompt` so the user can tweak and resubmit. */
  prompt: string;
  /** Phase 15.14 — vendor to use for this call. Falls back to 'atlas'
   *  when omitted, matching the dispatcher's pre-existing default. The
   *  route layer resolves precedence: body override > UserSettings >
   *  'atlas'. The orchestrator just takes what it's given. */
  vendor?: Gpt2EditVendor;
}

export interface RegenerateVariantResult {
  style_assets: ShortStyleAssets;
  costUsd: number;
  durationMs: number;
}

/**
 * Regenerate a single variant frame in place. Targets the current
 * `base_url` as the source image so a sequence of variant regens stays
 * visually consistent with the chosen base. Preserves the variant's
 * `caption_chunk_start_index` so the renderer-side timing doesn't shift.
 */
export async function regenerateVariantFrame(
  row: ShortRow,
  opts: RegenerateVariantOptions,
): Promise<RegenerateVariantResult> {
  const tStart = Date.now();
  const key = resolveStyleKey(row);
  const prevBlock = requireBlock(row, key);

  if (opts.index < 0 || opts.index >= prevBlock.variants.length) {
    throw new Error(
      `Variant index ${opts.index} out of range (have ${prevBlock.variants.length} variants).`,
    );
  }
  const target = prevBlock.variants[opts.index];

  console.info('[shorts frame-ops regenerate-variant] start', {
    shortId: row.id,
    workspaceId: row.workspace_id,
    styleKey: key,
    index: opts.index,
    chunkIndex: target.caption_chunk_start_index,
    baseUrl: prevBlock.base_url,
    promptChars: opts.prompt.length,
  });

  const result = await generateGptImage2Edit({
    prompt: opts.prompt,
    sourceImageUrl: prevBlock.base_url,
    primary: opts.vendor ?? 'atlas',
  });

  const nextVariants = prevBlock.variants.slice();
  nextVariants[opts.index] = {
    url: result.url,
    caption_chunk_start_index: target.caption_chunk_start_index,
    edit_prompt: opts.prompt,
  };
  const newBlock: FrameAssetsBlock = {
    base_url: prevBlock.base_url,
    base_prompt: prevBlock.base_prompt,
    variants: nextVariants,
  };
  const style_assets = mergeBlock(row.style_assets ?? {}, key, newBlock);
  const durationMs = Date.now() - tStart;

  logger.info('[shorts frame-ops regenerate-variant] done', {
    shortId: row.id,
    styleKey: key,
    index: opts.index,
    chunkIndex: target.caption_chunk_start_index,
    newUrl: result.url,
    vendorUsed: result.vendorUsed,
    fallbackUsed: result.fallbackUsed,
    costUsd: result.costUsd,
    durationMs,
  });

  return { style_assets, costUsd: result.costUsd, durationMs };
}

// ---------------------------------------------------------------------------
// 3. Append a new variant frame
// ---------------------------------------------------------------------------

export interface AppendVariantOptions {
  /** Edit prompt for the new variant. */
  prompt: string;
  /** Caption-chunk index the new variant lines up with. The renderer
   *  picks the variant whose `caption_chunk_start_index` is ≤ the
   *  current chunk, so this controls when the new frame swaps in. */
  captionChunkStartIndex: number;
  /** Phase 15.14 — vendor for this call. See `RegenerateVariantOptions`. */
  vendor?: Gpt2EditVendor;
}

export interface AppendVariantResult {
  style_assets: ShortStyleAssets;
  costUsd: number;
  durationMs: number;
  /** Index of the new variant in the returned (sorted) array. The UI
   *  uses this to scroll to / highlight the newly-added thumbnail. */
  newIndex: number;
}

/**
 * Append a new variant frame. The new variant is generated via Atlas
 * Edit against the current `base_url`, then inserted into the variants
 * array sorted by `caption_chunk_start_index` so the renderer-side
 * lookup (which assumes ascending chunk indices) keeps working. Stable
 * ordering preserved for ties.
 */
export async function appendVariantFrame(
  row: ShortRow,
  opts: AppendVariantOptions,
): Promise<AppendVariantResult> {
  const tStart = Date.now();
  const key = resolveStyleKey(row);
  const prevBlock = requireBlock(row, key);

  if (!Number.isFinite(opts.captionChunkStartIndex) || opts.captionChunkStartIndex < 0) {
    throw new Error(
      `captionChunkStartIndex must be a non-negative integer (got ${String(opts.captionChunkStartIndex)}).`,
    );
  }

  console.info('[shorts frame-ops append-variant] start', {
    shortId: row.id,
    workspaceId: row.workspace_id,
    styleKey: key,
    chunkIndex: opts.captionChunkStartIndex,
    baseUrl: prevBlock.base_url,
    promptChars: opts.prompt.length,
    existingVariantCount: prevBlock.variants.length,
  });

  const result = await generateGptImage2Edit({
    prompt: opts.prompt,
    sourceImageUrl: prevBlock.base_url,
    primary: opts.vendor ?? 'atlas',
  });

  const newVariant = {
    url: result.url,
    caption_chunk_start_index: opts.captionChunkStartIndex,
    edit_prompt: opts.prompt,
  };

  // Insert in sorted position. `findIndex` returns the first variant
  // with a STRICTLY-greater chunk index; ties go after the existing
  // entries (stable) so manual append order is preserved when two
  // variants legitimately share a chunk index.
  const insertAt = prevBlock.variants.findIndex(
    (v) => v.caption_chunk_start_index > opts.captionChunkStartIndex,
  );
  const nextVariants = prevBlock.variants.slice();
  const newIndex = insertAt === -1 ? nextVariants.length : insertAt;
  nextVariants.splice(newIndex, 0, newVariant);

  const newBlock: FrameAssetsBlock = {
    base_url: prevBlock.base_url,
    base_prompt: prevBlock.base_prompt,
    variants: nextVariants,
  };
  const style_assets = mergeBlock(row.style_assets ?? {}, key, newBlock);
  const durationMs = Date.now() - tStart;

  logger.info('[shorts frame-ops append-variant] done', {
    shortId: row.id,
    styleKey: key,
    chunkIndex: opts.captionChunkStartIndex,
    newIndex,
    newUrl: result.url,
    vendorUsed: result.vendorUsed,
    fallbackUsed: result.fallbackUsed,
    costUsd: result.costUsd,
    totalVariantsAfter: nextVariants.length,
    durationMs,
  });

  return { style_assets, costUsd: result.costUsd, durationMs, newIndex };
}

// ---------------------------------------------------------------------------
// 4. Delete a variant frame
// ---------------------------------------------------------------------------

export interface DeleteVariantOptions {
  /** Zero-based index of the variant to remove. */
  index: number;
}

export interface DeleteVariantResult {
  style_assets: ShortStyleAssets;
}

/**
 * Splice one variant out of the array. Pure data op — no vendor call,
 * no cost. The R2-hosted URL of the removed variant is left orphaned
 * (cheap, ~10kB/png, and the user might want to re-add it via
 * append). Mirrors how the long-form scene editor handles deleted
 * collage panels.
 */
export function deleteVariantFrame(
  row: ShortRow,
  opts: DeleteVariantOptions,
): DeleteVariantResult {
  const key = resolveStyleKey(row);
  const prevBlock = requireBlock(row, key);

  if (opts.index < 0 || opts.index >= prevBlock.variants.length) {
    throw new Error(
      `Variant index ${opts.index} out of range (have ${prevBlock.variants.length} variants).`,
    );
  }

  const removed = prevBlock.variants[opts.index];
  const nextVariants = prevBlock.variants.slice();
  nextVariants.splice(opts.index, 1);
  const newBlock: FrameAssetsBlock = {
    base_url: prevBlock.base_url,
    base_prompt: prevBlock.base_prompt,
    variants: nextVariants,
  };
  const style_assets = mergeBlock(row.style_assets ?? {}, key, newBlock);

  logger.info('[shorts frame-ops delete-variant] done', {
    shortId: row.id,
    styleKey: key,
    index: opts.index,
    removedChunkIndex: removed.caption_chunk_start_index,
    removedUrl: removed.url,
    remainingVariants: nextVariants.length,
  });

  return { style_assets };
}

/**
 * Server-side image generation for production-doc rows, invoked from
 * the auto-pipeline `generating_production_doc_images` stage handler.
 *
 * Mirrors the happy-path branches of /api/generate/production-doc/image
 * (for bases) and /api/generate/production-doc/image/edit (for
 * variants), reusing the same helper functions (resolveStyle,
 * loadStyleReferences, augmentCellPrompt, generateImageWithRefs,
 * generateAtlasEdit) so behavior stays consistent between manual
 * editor clicks and cron-driven pipeline runs. The HTTP route's
 * rate-limit + auth wrapping is bypassed — pipeline calls run in a
 * server-internal trusted context.
 *
 * v1 deliberately does NOT replicate every route nuance:
 *   - OST baking is OFF (assumes doc's on_screen_text_mode_default
 *     is 'overlay', which the pipeline stage stamps). Overlay text
 *     renders at composite time in Remotion; baking it into the
 *     diffusion prompt is a per-call decision the user makes from
 *     the editor.
 *   - Section title letterbox is honored via the canvas helper.
 *   - Saliency is skipped — overlay placement falls back to LLM
 *     zone. Stage handler can compute saliency in a follow-up tick
 *     if needed; not blocking image-gen.
 *
 * Plan: `_plans/2026-05-27-doodle-explainer-2-foundation.md` (Stage 4).
 */
import { resolveStyle } from '../production-doc-styles';
import { loadStyleReferences, mirrorPublicUrlRefToR2, type StyleReferenceImage } from '../production-doc-styles-refs';
import { generateImageWithRefs, ReferenceRejectedError } from '../image-gen-i2i';
import { DEFAULT_CLOUD_I2I_MODEL, getI2IModelSpec, resolveI2iModelForRow } from '../image-models-i2i';
import { generateAtlasT2I, generateAtlasI2I } from './../atlas-cloud-images';
import { generateGptImage2Edit } from '../gpt-image-2-edit';
import { createKieTask, pollKieResult } from '../kie-poll';
import { getUserSettings } from '../user-settings';
import { composeCollagePrompt } from '../collage-prompt';
import { detectMalformedCollage } from '../collage-detect';
import { sliceCollage, sliceCollageGrid, MAX_COLLAGE_CELLS } from '../collage-slicer';
import {
  buildCharacterBibleBlock,
  composeMotionCollagePrompt,
  composePerPanelPrompt,
} from '../motion-collage-prompt';
import { generateMouthRemovedBase } from '../atlas-mouth-removal';
import { cropTo16x9AndUpload, mirrorImageToR2 } from '../image-gen-dispatch';
import { upscaleViaRecraft } from '../upscale';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  getReviewBucket,
  uploadToBucket,
} from '../r2';
import { augmentCellPrompt, COLLAGE_CELL_PROMPT_CAP, SINGLE_SHOT_PROMPT_CAP } from '../prompt-augmentation';
import { SAFE_FRAMING_EDIT_SUFFIX } from '../prompt-framing';
import { computeImageCanvas } from '../render-canvas';
import { logger } from '../logger';
import { recordIntent, markDelivered, markFailed } from '../provider-generations';
import { scrubScaleVerbs } from '../verb-scrubber';

/**
 * PR4 of 2026-06-03 plan — motion-collage chain depth cap.
 *
 * Empirically, chained Atlas Edit drifts ~5% per step on the
 * composition (sticky-note positions, prop scales, background detail).
 * After ~4 steps the cumulative drift is visible to viewers. Past
 * panel index 3 (the fourth iteration), each subsequent panel
 * anchors directly to panel 0 instead of chaining off the previous
 * panel — the chain becomes a fan-out from panel 0 rather than a
 * straight line. Cost: motion arc between anchored panels is choppier
 * (each anchored panel interprets pose independently). Benefit:
 * composition stays locked to panel 0 verbatim.
 *
 * Set per the dual-input experiment data + the user's 2026-06-03
 * complaint about figures changing sizes across panels.
 */
const MOTION_COLLAGE_MAX_CHAIN_DEPTH = 4;

/** Per-row generation outcome. `imageUrl` set on success; on failure
 *  `error` carries the classified reason so the stage handler can
 *  decide whether to retry, skip, or fail the whole stage. */
export interface PipelineImageResult {
  imageUrl?: string;
  error?: string;
  durationMs: number;
  modelUsed?: string;
  /** $ estimate so the stage handler can roll up cost without
   *  re-reading model specs. Atlas Edit = $0.011, i2i = ~$0.04. */
  costUsd: number;
}

/** Minimal row shape this module reads from. Mirrors the relevant
 *  fields of `ProductionRow` without dragging the whole type from
 *  remotion/utils.ts (that file isn't safe to import here — it pulls
 *  React-only deps). */
export interface PipelineImageRow {
  ai_image_prompt?: string;
  visual_type?: string;
  on_screen_text?: string;
  on_screen_text_mode?: 'bake' | 'overlay' | 'none';
  section_title?: string;
  section_title_layout?: 'overlay' | 'letterbox';
  image_url?: string;
  group_id?: string;
  variant_index?: number;
  variant_edit_prompt?: string;
  variant_derives_from_previous?: boolean;
  /** Phase 1.7 R5 — per-group default for chain mode. Set on the BASE
   *  row (variant_index === 0) only. The auto-pipeline dispatcher
   *  resolves a variant's effective chain mode via the three-tier
   *  priority: this variant's `variant_derives_from_previous` →
   *  the base's `group_variant_chain_default` → the doc's
   *  `variants_chained_by_default`. Same shape as the canonical
   *  field on ProductionRow in src/remotion/utils.ts. */
  group_variant_chain_default?: 'parallel' | 'chained';
  // ─── paint_explainer_v1 (2026-05-28) ──────────────────────────────
  // Inline subset of the full MotionBeat / character fields defined on
  // ProductionRow in src/remotion/utils.ts. Re-stated here (not imported)
  // because remotion/utils.ts pulls React-only deps unsafe for this
  // server-only module. The shape must stay in sync with the upstream
  // type — pipeline runs would silently miss new beat kinds otherwise.
  character_id?: string;
  motion_beats?: Array<{ kind: string }>;
  mouth_removed_url?: string;
  /** Phase 3 — recurring location/object slug. Server-only mirror of
   *  ProductionRow.scene_id. */
  scene_id?: string;
  // ─── doodle_explainer_2 motion_collage (2026-05-31) ────────────────
  // Server-only mirror of ProductionRow.{shot_kind, motion_collage_*}.
  // Re-stated here (not imported) for the same reason as the
  // paint_explainer_v1 block above. See
  // `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.
  shot_kind?: 'static' | 'motion' | 'hard_cut' | 'motion_collage';
  motion_collage_grid?: { cols: number; rows: number };
  motion_collage_panel_prompts?: string[];
  motion_collage_image_url?: string;
  motion_collage_panel_urls?: string[];
  // ─── PR2 reliability (2026-06-03) ────────────────────────────────
  // Server-only mirror of ProductionRow.{attempts, last_error} in
  // src/remotion/utils.ts. The stage handler writes these on every
  // failed generation; the plan-build + stillRemaining checks read
  // them to enforce the circuit breaker.
  attempts?: number;
  last_error?: {
    class:
      | 'content_policy'
      | 'reference_rejected'
      | 'model_rejected'
      | 'blank_output'
      | 'timeout'
      | 'invalid_prompt'
      | 'no_refs'
      | 'source_missing'
      | 'killed'
      | 'validation_failed'
      | 'unknown';
    message: string;
    at: string;
  } | null;
  /** Per-row override for the i2i model. When set, takes precedence
   *  over the doc-level override and the style preset's
   *  preferred_cloud_model. Operator picks this from the per-row
   *  "Regenerate with model" UI when they want one specific bad row
   *  to use a different model. 2026-06-08. */
  image_model_override?: string;
}

/** Doc-level fields the helper needs to dispatch correctly. */
export interface PipelineImageDoc {
  rows: PipelineImageRow[];
  style_preset?: string;
  /** Channel-clone per-doc style override. When present, the image-
   *  gen pipeline uses the channel's own extracted frames as Atlas
   *  i2i references INSTEAD of the style preset's bundled refs. The
   *  suffix has already been baked into every row's ai_image_prompt
   *  by the rowify stage; image-gen only needs to swap the refs.
   *  Set by `handoff-runner` when the channel-clone job's
   *  `state_jsonb.channelStyle` is populated. */
  channel_style_override?: {
    ai_image_suffix: string;
    ref_r2_keys: string[];
    reason: string;
  } | null;
  on_screen_text_mode_default?: 'bake' | 'overlay' | 'none';
  section_title_layout_default?: 'overlay' | 'letterbox';
  // ─── paint_explainer_v1 (2026-05-28) ──────────────────────────────
  // Per-doc cache of recurring-character mouth-removed bases, keyed by
  // PipelineImageRow.character_id. Same shape as
  // ProductionDoc.paint_explainer_v1_character_cache — re-stated here
  // for the same reason as above (no React imports in server code).
  paint_explainer_v1_character_cache?: Record<string, {
    base_url: string;
    mouth_removed_url?: string;
    anchors?: Partial<Record<'auto-mouth' | 'auto-center' | 'auto-eyes', { xPct: number; yPct: number }>>;
  }>;
  // ─── doodle_explainer_2 (2026-05-28) ───────────────────────────────
  // Per-doc cache of recurring-character base images for the Atlas
  // Edit character-continuation path. Same shape as
  // ProductionDoc.doodle_explainer_2_character_cache — re-stated here
  // for the same reason as above (no React imports in server code).
  // See _plans/2026-05-28-doodle-2-character-cache.md.
  doodle_explainer_2_character_cache?: Record<string, {
    base_url: string;
    first_seen_row_index: number;
  }>;
  // ─── paint_explainer_v1 prop cache (2026-05-30) ───────────────────
  // Per-doc cache of transparent-prop PNGs generated for PropSlideIn
  // motion beats. Same shape as
  // ProductionDoc.paint_explainer_v1_prop_cache — re-stated here for
  // the same reason as above (no React imports in server code).
  paint_explainer_v1_prop_cache?: Record<string, string>;
  /** Phase 3 — scene cache (server-only mirror of
   *  ProductionDoc.doodle_explainer_2_scene_cache). See
   *  _plans/2026-05-28-doodle-2-scene-cache.md. */
  doodle_explainer_2_scene_cache?: Record<string, {
    base_url: string;
    first_seen_row_index: number;
  }>;
  /** Phase 2 (Character Bible) — server-only mirror of
   *  ProductionDoc.doodle_explainer_2_character_descriptions. The
   *  pipeline's `generateBaseImage` passes this through to
   *  `augmentCellPrompt` so the prompt augmentation prepends the
   *  character reference block. See
   *  _plans/2026-05-28-doodle-2-character-bible.md. */
  doodle_explainer_2_character_descriptions?: Record<string, string>;
  /** Phase 1.7 R5 — doc-level default for chain mode. Tier 3 in the
   *  three-tier resolution; only applies when neither the variant's
   *  own flag nor the base row's `group_variant_chain_default` is
   *  set. Same shape as the canonical field on ProductionDoc. */
  variants_chained_by_default?: boolean;
  /** 2026-05-28 collage-port — doc-level toggle. Default-on semantics:
   *  `undefined | true` → collage path runs for eligible bases; `false`
   *  → every base goes single-shot. Same shape as the canonical field on
   *  ProductionDoc; the auto-pipeline's collage planner reads this once
   *  per tick. See _plans/2026-05-28-auto-pipeline-collage-port.md. */
  collage_mode?: boolean;
  // ─── doodle_explainer_2 motion_collage (2026-05-31) ────────────────
  // Server-only mirror of
  // ProductionDoc.doodle_explainer_2_motion_collage_settings. The
  // `generateMotionCollage` helper resolves defaults inline; this
  // type only carries the optional stored shape. See
  // `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.
  doodle_explainer_2_motion_collage_settings?: {
    allow_motion_collage?: boolean;
    max_grid_panels?: number;
    min_per_frame_ms?: number;
    max_per_frame_ms?: number;
  };
  /** Doc-level override for the i2i model. When set, applies to every
   *  base row in the doc that lacks a row-level override. Takes
   *  precedence over the style preset's preferred_cloud_model.
   *  Operator picks this from the top of the per-row progress panel
   *  when they want to switch the whole doc to a different image
   *  model (e.g. Grok Imagine is failing → switch to Flux 2 Pro).
   *  2026-06-08. */
  image_model_override?: string;
}

/** Synthesize StyleReferenceImage records from a channel-clone
 *  override's R2 keys. The dispatcher (generateImageWithRefs) only
 *  reads a handful of these fields — r2_bucket, r2_key, mime_type,
 *  rejected_by_provider, content_validated, position, weight, role —
 *  so we fill those with safe defaults and stub the rest. Bucket is
 *  the review bucket where intake-runner.ts uploaded the frames.
 *  All synthetic refs are marked content_validated=true because we
 *  wrote the bytes ourselves and know they're valid JPEG/PNG. */
function synthesizeChannelOverrideRefs(
  r2Keys: string[],
  workspaceId: string,
  styleId: string,
): StyleReferenceImage[] {
  const bucket = getReviewBucket();
  const now = new Date().toISOString();
  return r2Keys.map((r2Key, idx): StyleReferenceImage => {
    const isPng = r2Key.toLowerCase().endsWith('.png');
    return {
      id: `channel-clone-override-${idx}`,
      style_id: styleId,
      workspace_id: workspaceId,
      position: idx,
      role: 'style',
      weight: 1,
      r2_bucket: bucket,
      r2_key: r2Key,
      size_bytes: null,
      mime_type: isPng ? 'image/png' : 'image/jpeg',
      width: null,
      height: null,
      rejected_by_provider: false,
      rejection_reason: null,
      rejection_provider: null,
      rejected_at: null,
      created_at: now,
      content_validated: true,
      content_validation_error: null,
      content_validated_at: now,
    };
  });
}

/**
 * Generate the image for a single base row (variant_index === 0 or
 * standalone). Resolves the style + refs, augments the prompt, and
 * dispatches via `generateImageWithRefs` (which auto-routes Kie /
 * Atlas / ComfyUI based on the style's preferred_cloud_model).
 *
 * Returns `{ imageUrl }` on success, `{ error }` on failure. Never
 * throws — the stage handler wants per-row outcomes, not per-stage
 * exceptions.
 */
export async function generateBaseImage(args: {
  row: PipelineImageRow;
  doc: PipelineImageDoc;
  workspaceId: string;
  ownerId?: string;
}): Promise<PipelineImageResult> {
  const t0 = Date.now();
  const { row, doc, workspaceId, ownerId } = args;
  const promptRaw = (row.ai_image_prompt ?? '').trim();
  if (!promptRaw) {
    return { error: 'empty_ai_image_prompt', durationMs: Date.now() - t0, costUsd: 0 };
  }

  const styleId = doc.style_preset?.trim();
  const style = styleId ? await resolveStyle(styleId, workspaceId, ownerId ?? null) : null;
  // Channel-clone path: when the doc carries a per-job style override
  // we use the channel's actual extracted frames as i2i references
  // INSTEAD of the preset's bundled refs. That's the whole point of
  // channel-clone — render each shot in the source channel's look,
  // not in our default illustration style.
  const channelOverride = doc.channel_style_override;
  // Per-row varied refs (2026-06-08): when the channel-override pool
  // has more than 4 frames, pick a row-specific 4-frame window so
  // different rows reference different parts of the channel rather
  // than every row drawing from the same 4 frames. The window
  // ROTATES through the pool by row index, with a 2-frame stride so
  // adjacent rows still share style anchors. Atlas i2i caps at 4
  // refs per call regardless of pool size, so we always slice to 4.
  const rowIndexForSlice = lookupRowIndex(row, doc);
  const channelRefSlice = channelOverride && channelOverride.ref_r2_keys.length > 0
    ? pickPerRowRefSlice(channelOverride.ref_r2_keys, rowIndexForSlice, 4)
    : [];
  const refs = channelRefSlice.length > 0
    ? synthesizeChannelOverrideRefs(channelRefSlice, workspaceId, style?.id ?? 'channel-clone')
    : style
      ? await loadStyleReferences(style.id, {
          excludeRejected: true,
          excludeUnvalidated: true,
          workspaceId,
        })
      : [];

  // Section-title canvas + augmented prompt mirror the manual route.
  // OST baking is OFF on the pipeline path — the doc default is
  // 'overlay' (renderer composites text) so we never bake.
  const normalizedLayout: 'overlay' | 'letterbox' =
    row.section_title_layout === 'overlay' || row.section_title_layout === 'letterbox'
      ? row.section_title_layout
      : doc.section_title_layout_default ?? 'letterbox';
  const canvas = computeImageCanvas({
    sectionTitle: row.section_title,
    sectionTitleLayout: normalizedLayout,
  });
  const augmented = augmentCellPrompt({
    prompt: promptRaw,
    onScreenText: row.on_screen_text,
    onScreenTextMode: 'overlay', // pipeline never bakes
    sectionTitle: row.section_title,
    sectionTitleLayout: normalizedLayout,
    // Phase 2 (Character Bible) — pass the doc-level descriptions
    // through so non-anchored characters render consistently. No-op
    // when the doc field is unset.
    characterDescriptions: doc.doodle_explainer_2_character_descriptions,
    promptCap: SINGLE_SHOT_PROMPT_CAP,
    source: 'pipeline-image-gen',
  });

  if (!style || refs.length === 0) {
    // No refs → fall through to T2I via a default cloud model. v1
    // doesn't wire this branch in detail; most styled docs have refs.
    // Return a clear error so the stage handler can decide what to do.
    return {
      error: 'no_style_refs_available',
      durationMs: Date.now() - t0,
      costUsd: 0,
    };
  }

  // i2i model resolution priority (2026-06-08):
  //   1. row.image_model_override     — per-row override from the
  //      per-row "Regenerate with model X" UI button.
  //   2. doc.image_model_override     — doc-level override from the
  //      per-doc "Switch image model" picker.
  //   3. style.preferred_cloud_model  — style-preset default.
  //   4. DEFAULT_CLOUD_I2I_MODEL      — final fallback.
  // Each override is validated against the I2I registry; an unknown
  // value falls through to the next tier so a stale row override
  // doesn't strand the row forever.
  const candidateOverrides: Array<string | undefined> = [
    row.image_model_override,
    doc.image_model_override,
    style.preferred_cloud_model,
  ];
  let i2iModel: string = DEFAULT_CLOUD_I2I_MODEL;
  for (const candidate of candidateOverrides) {
    if (candidate && getI2IModelSpec(candidate)) {
      i2iModel = candidate;
      break;
    }
  }
  const i2iSpec = getI2IModelSpec(i2iModel);
  // Skip the audit row for local ComfyUI — no money is moving. Cloud
  // i2i (Kie / Atlas) always records. See Phase 1.0 of
  // _plans/2026-05-29-persistence-rebuild.md.
  const isPaidI2i = i2iSpec?.provider !== 'comfyui-local';
  const intent = isPaidI2i
    ? await recordIntent({
        userId: ownerId ?? null,
        workspaceId,
        route: 'auto-pipeline:generateBaseImage',
        provider: i2iSpec?.provider ?? 'unknown',
        providerModel: i2iModel,
      })
    : null;
  try {
    const result = await generateImageWithRefs(i2iModel, augmented.prompt, refs, {
      r2KeyPrefix: i2iSpec?.provider === 'comfyui-local'
        ? 'prodoc-images-i2i-local'
        : 'prodoc-images-i2i',
      width: canvas.width,
      height: canvas.height,
    });
    // Cost estimate — Atlas i2i = $0.011, NanoBanana 2 = $0.04.
    // Use a per-spec value when available; fall back to a conservative
    // $0.04 to avoid undercounting.
    const costUsd = i2iSpec?.costUsdPerImage ?? 0.04;
    if (intent) {
      void markDelivered({
        id: intent.id,
        providerRequestId: result.kieTaskId ?? result.comfyPromptId ?? null,
        responseUrl: result.imageUrl,
        costUsd,
        durationMs: result.durationMs,
      });
    }
    logger.info('[pipeline image-gen base] succeeded', {
      model: i2iModel,
      refs_sent: result.refsSent,
      duration_ms: result.durationMs,
      cost_usd: costUsd,
    });
    return {
      imageUrl: result.imageUrl,
      durationMs: Date.now() - t0,
      modelUsed: result.modelUsed,
      costUsd,
    };
  } catch (err) {
    if (intent) {
      void markFailed({
        id: intent.id,
        failureReason: err instanceof Error ? err.message : String(err),
      });
    }
    if (err instanceof ReferenceRejectedError) {
      return {
        error: `reference_rejected:${err.reason}`,
        durationMs: Date.now() - t0,
        costUsd: 0,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    // error-level: a base i2i failure leaves the row stuck without an image,
    // which the stage handler treats as "skip and retry next tick" — easy to
    // miss in a busy pipeline. Surfacing in Vercel's error feed makes a
    // persistent vendor outage visible the same day instead of two days later.
    logger.error('[atlas-edit-failed pipeline base]', { detail: msg.slice(0, 200) });
    return { error: msg.slice(0, 200), durationMs: Date.now() - t0, costUsd: 0 };
  }
}

/**
 * Generate a variant image — Atlas GPT Image 2 Edit against the
 * SOURCE row's image (base for parallel variants; previous variant
 * for chained). The source must already have a generated image_url
 * persisted on the row; v1 doesn't fall back to in-flight URLs.
 *
 * Composes the edit prompt inline (doesn't re-use
 * composeVariantEditRequest because that helper lives in
 * remotion/utils.ts which pulls React deps unsafe for server-only
 * code).
 */
export async function generateVariantImage(args: {
  row: PipelineImageRow;
  doc: PipelineImageDoc;
  /** Workspace id for the provider_generations audit row. Defaults to
   *  null when the caller (legacy test) doesn't pass it; the row still
   *  records but with no workspace attribution. New callers should
   *  always provide. */
  workspaceId?: string | null;
  ownerId?: string | null;
}): Promise<PipelineImageResult> {
  const t0 = Date.now();
  const { row, doc, workspaceId = null, ownerId = null } = args;
  const variantIdx = row.variant_index ?? 0;
  if (variantIdx <= 0) {
    return { error: 'not_a_variant', durationMs: Date.now() - t0, costUsd: 0 };
  }
  const groupId = row.group_id;
  if (!groupId) {
    return { error: 'no_group_id', durationMs: Date.now() - t0, costUsd: 0 };
  }
  const editInstruction = (row.variant_edit_prompt ?? '').trim();
  if (!editInstruction) {
    return { error: 'no_edit_prompt', durationMs: Date.now() - t0, costUsd: 0 };
  }

  // Resolve the SOURCE row. Chained variants edit the previous
  // variant's image; parallel variants edit the group's base. Falls
  // back to the base when chaining is requested but the previous
  // variant is missing (defensive).
  //
  // Phase 1.7 R5: three-tier chain resolution (variant own flag →
  // base's group_variant_chain_default → doc's
  // variants_chained_by_default → parallel). Mirrors
  // `resolveVariantChainMode` in src/remotion/utils.ts so the
  // auto-pipeline and manual editor route variants identically.
  const baseRow = doc.rows.find(
    (r) => r.group_id === groupId && (r.variant_index ?? 0) === 0,
  );
  let resolvedChainMode: 'parallel' | 'chained' = 'parallel';
  if (typeof row.variant_derives_from_previous === 'boolean') {
    resolvedChainMode = row.variant_derives_from_previous ? 'chained' : 'parallel';
  } else if (baseRow?.group_variant_chain_default === 'chained') {
    resolvedChainMode = 'chained';
  } else if (baseRow?.group_variant_chain_default === 'parallel') {
    resolvedChainMode = 'parallel';
  } else if (doc.variants_chained_by_default === true) {
    resolvedChainMode = 'chained';
  }
  let sourceRow: PipelineImageRow | undefined;
  if (resolvedChainMode === 'chained' && variantIdx > 1) {
    sourceRow = doc.rows.find(
      (r) => r.group_id === groupId && (r.variant_index ?? 0) === variantIdx - 1,
    );
  }
  if (!sourceRow) {
    sourceRow = baseRow;
  }
  if (!sourceRow) {
    return { error: 'source_row_not_found', durationMs: Date.now() - t0, costUsd: 0 };
  }
  const sourceImageUrl = sourceRow.image_url?.trim();
  if (!sourceImageUrl) {
    return { error: 'source_image_not_generated', durationMs: Date.now() - t0, costUsd: 0 };
  }

  // Compose the edit prompt: just the delta + a soft preservation
  // hint. Same shape as composeVariantEditRequest's short-format
  // branch; v1 skips the doodle-specific hint table here (the prompt
  // is short enough on its own that Atlas Edit + the input image do
  // the heavy lifting).
  //
  // PR4 (2026-06-03) — scrub scale/size verbs from the variant edit
  // instruction. Variants drift the same way motion-collage panels do
  // when the LLM emits "grows" / "fills the frame" past the prompt
  // directive. Same scrubber, applied at the same layer (composer
  // input) so a "grows" word never reaches Atlas Edit.
  const scrubbedEditInstruction = scrubScaleVerbs(editInstruction).text;
  const trimmedInstruction = scrubbedEditInstruction.replace(/\.\s*$/, '');
  let composedPrompt = `${trimmedInstruction}. Keep everything else in the image identical to the input.`;
  // Phase 1.7 R5 (chained variants) — when this variant edits from
  // the previous variant (not the base), append the identity anchor
  // so Atlas Edit doesn't compound style drift across V1 → V2 → V3.
  // The chain decision uses the same three-tier resolution as the
  // manual editor (see above). Spec:
  // _plans/2026-05-28-doodle-2-chained-variants.md (R4 + R5).
  const isChainedFromPrevious = resolvedChainMode === 'chained' && variantIdx > 1;
  if (isChainedFromPrevious) {
    const { CHAINED_VARIANT_IDENTITY_ANCHOR } = await import('../../remotion/utils');
    composedPrompt += ` ${CHAINED_VARIANT_IDENTITY_ANCHOR}`;
  }
  // 2026-05-28 framing fix: variant Edit runs at 1536×1024 → crop to
  // 1536×864 (16:9), so 7.8% of pixels off the top + 7.8% off the bottom
  // are destroyed downstream. Without this suffix the model has zero
  // framing instruction (the inline compose above doesn't flow through
  // augmentCellPrompt's safeEdgeDirective) and reliably places
  // character heads + bottom text in the destroy band.
  composedPrompt += SAFE_FRAMING_EDIT_SUFFIX;

  // Read the owner's vendor preference once per pipeline call. Default
  // 'atlas' matches the legacy behaviour when the setting is unset.
  // ownerId may be null in legacy test paths; getUserSettings returns
  // defaults in that case.
  const ownerSettings = await getUserSettings(ownerId ?? '');
  const editPrimary = ownerSettings.gpt_image_2_edit_primary ?? 'atlas';
  const intent = await recordIntent({
    userId: ownerId,
    workspaceId,
    route: 'auto-pipeline:generateVariantImage',
    provider: editPrimary,
    providerModel: 'openai/gpt-image-2/edit',
  });
  try {
    // 1536×1024 → cropTo16x9AndUpload (when Atlas served) → Recraft
    // upscale. The dispatcher returns a 16:9 URL regardless of vendor
    // (it crops Atlas internally; Kie i2i returns 16:9 natively), so
    // this caller's downstream chain is unchanged.
    const dispatched = await generateGptImage2Edit({
      prompt: composedPrompt,
      sourceImageUrl,
      primary: editPrimary,
    });
    const upscale = await upscaleViaRecraft(dispatched.url);
    let imageUrl = upscale.url;
    try {
      const imgRes = await fetch(upscale.url);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const ext = contentType.includes('png') ? 'png' : 'jpg';
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `prodoc-images/${Date.now()}-pipe-variant-${randomSuffix}.${ext}`;
        await uploadToBucket(bucket, r2Key, buffer, contentType);
        imageUrl = await getDownloadUrlForBucket(
          bucket,
          r2Key,
          process.env.R2_IMAGES_PUBLIC_URL,
        );
      }
    } catch (uploadErr) {
      logger.warn('[pipeline image-gen variant] R2 mirror failed, using upscale URL', {
        detail: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
      });
    }
    void markDelivered({
      id: intent.id,
      providerRequestId: dispatched.providerRequestId,
      responseUrl: imageUrl,
      costUsd: dispatched.costUsd,
      durationMs: dispatched.durationMs,
    });
    logger.info('[pipeline image-gen variant] succeeded', {
      group_id: groupId,
      variant_index: variantIdx,
      vendor_used: dispatched.vendorUsed,
      fallback_used: dispatched.fallbackUsed,
      duration_ms: dispatched.durationMs,
      cost_usd: dispatched.costUsd,
    });
    return {
      imageUrl,
      durationMs: Date.now() - t0,
      modelUsed: 'openai/gpt-image-2/edit',
      costUsd: dispatched.costUsd,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void markFailed({
      id: intent.id,
      failureReason: msg,
    });
    // error-level: variant failures leave the group's V1/V2/V3 column empty
    // and the renderer falls through to the base, masking the loss visually.
    logger.error('[gpt2-edit-failed pipeline variant]', { detail: msg.slice(0, 200) });
    return { error: msg.slice(0, 200), durationMs: Date.now() - t0, costUsd: 0 };
  }
}

/**
 * Generate the mouth-removed variant of a paint_explainer_v1 character
 * base. Used by the Remotion `<MouthSwap>` overlay as the bottom layer
 * onto which procedural mouth-state PNGs are composited.
 *
 * Pipeline: Atlas Edit (mouth-removal prompt) → center-crop to 16:9 →
 * Recraft upscale → R2 mirror. Mirrors `generateVariantImage`'s
 * cleanup chain exactly so the mouth-removed PNG ends up at the same
 * resolution + aspect as the row's `image_url` base, which is critical
 * for the `<MouthSwap>` overlay to register pixel-perfectly with the
 * underlying eyes / eyebrows / head outline.
 *
 * Stateless: the caller (stage handler one layer above this module) is
 * responsible for:
 *   1. Reading `ProductionDoc.paint_explainer_v1_character_cache`
 *      before calling, to skip duplicates when the same character_id
 *      already has a generated pair in this doc.
 *   2. Writing the returned URL into both the cache AND the row's
 *      `mouth_removed_url` field after a successful call.
 *   3. Emitting `[paint-explainer-v1 atlas-mouth-removed]` cost
 *      telemetry tagged with row_id + character_id (per §13 of
 *      `_plans/2026-05-28-paint-explainer-v1-architecture.md`).
 *
 * Never throws — returns `{ error }` so the stage handler can either
 * skip the mouth-swap motion beat (rendering the static base) or fail
 * the row depending on policy.
 *
 * Cost: ~$0.011 (Atlas Edit) + ~$0.0025 (Recraft upscale) ≈ $0.014.
 * Reported as $0.011 in the return value to match the variant path's
 * accounting (Recraft is rolled into the system-wide upscale budget
 * tracked separately in cost telemetry).
 */
export async function generateMouthRemovedForCharacter(args: {
  baseImageUrl: string;
  characterId: string;
  /** Owner of the doc — used to read `gpt_image_2_edit_primary`.
   *  Optional for back-compat with legacy callers / tests; defaults
   *  to whatever `getUserSettings('')` returns ('atlas' currently). */
  ownerId?: string | null;
}): Promise<PipelineImageResult> {
  const t0 = Date.now();
  const { baseImageUrl, characterId, ownerId = null } = args;
  if (!baseImageUrl.trim()) {
    return { error: 'empty_base_image_url', durationMs: Date.now() - t0, costUsd: 0 };
  }
  if (!characterId.trim()) {
    return { error: 'empty_character_id', durationMs: Date.now() - t0, costUsd: 0 };
  }

  try {
    const ownerSettings = await getUserSettings(ownerId ?? '');
    const editPrimary = ownerSettings.gpt_image_2_edit_primary ?? 'atlas';
    // Dispatcher returns a 16:9 URL (Atlas: cropped from 1536×1024; Kie:
    // native 16:9). Same downstream chain as generateVariantImage — the
    // mouth-removed PNG must end up at the same 16:9 aspect and post-
    // upscale resolution as the row's `image_url` base so the Remotion
    // `<MouthSwap>` overlay lines up with the underlying face.
    const removal = await generateMouthRemovedBase(baseImageUrl, editPrimary);
    const upscale = await upscaleViaRecraft(removal.url);
    let mouthRemovedUrl = upscale.url;
    try {
      const imgRes = await fetch(upscale.url);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const ext = contentType.includes('png') ? 'png' : 'jpg';
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `prodoc-images/${Date.now()}-pipe-mouth-removed-${randomSuffix}.${ext}`;
        await uploadToBucket(bucket, r2Key, buffer, contentType);
        mouthRemovedUrl = await getDownloadUrlForBucket(
          bucket,
          r2Key,
          process.env.R2_IMAGES_PUBLIC_URL,
        );
      }
    } catch (uploadErr) {
      logger.warn('[pipeline image-gen mouth-removed] R2 mirror failed, using upscale URL', {
        detail: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
      });
    }
    logger.info('[pipeline image-gen mouth-removed] succeeded', {
      character_id: characterId,
      vendor_used: removal.vendorUsed,
      fallback_used: removal.fallbackUsed,
      predict_ms: removal.predictTimeMs,
      cost_usd: removal.costUsd,
    });
    return {
      imageUrl: mouthRemovedUrl,
      durationMs: Date.now() - t0,
      modelUsed: 'openai/gpt-image-2/edit',
      costUsd: removal.costUsd,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // error-level: a missing mouth_removed_url silently disables the
    // <MouthSwap> overlay's lip-sync motion beats — the renderer falls
    // back to the static base and the video ships without the planned
    // animation. Easy to miss without a loud signal.
    logger.error('[gpt2-edit-failed pipeline mouth-removed]', {
      character_id: characterId,
      detail: msg.slice(0, 200),
    });
    return { error: msg.slice(0, 200), durationMs: Date.now() - t0, costUsd: 0 };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// doodle_explainer_2 character continuation (2026-05-28)
//
// When a row in a doodle_explainer_2 doc carries a `character_id` that the
// per-doc character cache already knows about, the image-gen pipeline
// skips the normal i2i path (which would draw a fresh character from
// scratch, drifting in face/hair/clothing) and instead calls Atlas Edit
// on the cached base with the row's new scene as the edit prompt. Atlas
// Edit preserves the character's identity while changing pose / setting
// / expression — validated end-to-end by the smoke test at
// `_plans/2026-05-28-atlas-edit-smoke/`.
//
// Stateless, like `generateMouthRemovedForCharacter`. The stage handler
// owns cache lookup / write-back / telemetry. Plan reference:
// `_plans/2026-05-28-doodle-2-character-cache.md`.
// ───────────────────────────────────────────────────────────────────────────

/** Wrap a row's `ai_image_prompt` into an Atlas Edit instruction that
 *  preserves the character's identity from the cached base image.
 *
 *  Canonical definition lives in `src/lib/character-cache.ts` so the
 *  production-doc page can share the wording without crossing the
 *  auto-pipeline boundary (the auto-pipeline module pulls server-only
 *  dependencies via `generateAtlasEdit` etc.). Re-exported here so the
 *  existing auto-pipeline callers + the stage-handler tests keep their
 *  imports stable. */
import { buildCharacterContinuationEditPrompt as _buildCharacterContinuationEditPrompt } from '../character-cache';
export const buildCharacterContinuationEditPrompt = _buildCharacterContinuationEditPrompt;
import { buildSceneContinuationEditPrompt as _buildSceneContinuationEditPrompt } from '../scene-cache';
export const buildSceneContinuationEditPrompt = _buildSceneContinuationEditPrompt;
import { prependCharacterBible } from '../character-bible';

/** Generate a character-continuation image via Atlas Edit on a cached
 *  base. The cached base is what the FIRST row featuring the character
 *  produced via i2i; this call lets every SUBSEQUENT row reuse that
 *  character's identity while changing the scene around them.
 *
 *  Mirrors the post-Edit chain used by `generateMouthRemovedForCharacter`:
 *  crop to 16:9 → upscale via Recraft → mirror to R2 so the resulting
 *  URL is a long-lived R2 GET (not a vendor CDN URL that could expire).
 *
 *  Stateless: the caller (stage handler) is responsible for:
 *    1. Looking up the cache before calling.
 *    2. Writing the returned URL into the row's `image_url` field on success.
 *    3. Emitting `[doodle-2 character-cache] hit-and-edit` cost telemetry.
 *
 *  Never throws — returns `{ error }` so the stage handler can fall back
 *  to a fresh i2i generation if Edit drifts too far or fails. */
export async function generateCharacterContinuationImage(args: {
  baseImageUrl: string;
  characterId: string;
  newScenePrompt: string;
  /** Phase 2 (Character Bible) — when provided, prepended to the
   *  composed Atlas Edit prompt so secondary characters in this row
   *  have consistent reference language. */
  characterDescriptions?: Record<string, string>;
  /** Audit-row attribution for provider_generations. Optional for
   *  back-compat with legacy callers / tests; new code should always
   *  pass workspaceId so reconciliation can group by workspace. */
  workspaceId?: string | null;
  ownerId?: string | null;
}): Promise<PipelineImageResult> {
  const t0 = Date.now();
  const {
    baseImageUrl,
    characterId,
    newScenePrompt,
    characterDescriptions,
    workspaceId = null,
    ownerId = null,
  } = args;
  if (!baseImageUrl.trim()) {
    return { error: 'empty_base_image_url', durationMs: Date.now() - t0, costUsd: 0 };
  }
  if (!characterId.trim()) {
    return { error: 'empty_character_id', durationMs: Date.now() - t0, costUsd: 0 };
  }
  if (!newScenePrompt.trim()) {
    return { error: 'empty_scene_prompt', durationMs: Date.now() - t0, costUsd: 0 };
  }

  const editPrompt = prependCharacterBible(
    buildCharacterContinuationEditPrompt(newScenePrompt),
    characterDescriptions,
  );
  const ownerSettings = await getUserSettings(ownerId ?? '');
  const editPrimary = ownerSettings.gpt_image_2_edit_primary ?? 'atlas';
  const intent = await recordIntent({
    userId: ownerId,
    workspaceId,
    route: 'auto-pipeline:generateCharacterContinuationImage',
    provider: editPrimary,
    providerModel: 'openai/gpt-image-2/edit',
  });
  try {
    // Dispatcher absorbs the per-vendor quirks (Atlas's 1536×1024 → 16:9
    // crop; Kie i2i returns 16:9 natively). The returned URL is 16:9 at
    // ~1K; downstream Recraft upscale brings it to ~4K.
    const dispatched = await generateGptImage2Edit({
      prompt: editPrompt,
      sourceImageUrl: baseImageUrl,
      primary: editPrimary,
    });
    const upscale = await upscaleViaRecraft(dispatched.url);
    let finalUrl = upscale.url;
    try {
      const imgRes = await fetch(upscale.url);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const ext = contentType.includes('png') ? 'png' : 'jpg';
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `prodoc-images/${Date.now()}-pipe-char-continuation-${randomSuffix}.${ext}`;
        await uploadToBucket(bucket, r2Key, buffer, contentType);
        finalUrl = await getDownloadUrlForBucket(
          bucket,
          r2Key,
          process.env.R2_IMAGES_PUBLIC_URL,
        );
      }
    } catch (uploadErr) {
      logger.warn('[pipeline image-gen character-continuation] R2 mirror failed, using upscale URL', {
        detail: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
      });
    }
    void markDelivered({
      id: intent.id,
      providerRequestId: dispatched.providerRequestId,
      responseUrl: finalUrl,
      costUsd: dispatched.costUsd,
      durationMs: dispatched.durationMs,
    });
    logger.info('[pipeline image-gen character-continuation] succeeded', {
      character_id: characterId,
      vendor_used: dispatched.vendorUsed,
      fallback_used: dispatched.fallbackUsed,
      duration_ms: dispatched.durationMs,
      cost_usd: dispatched.costUsd,
    });
    return {
      imageUrl: finalUrl,
      durationMs: Date.now() - t0,
      modelUsed: 'openai/gpt-image-2/edit',
      costUsd: dispatched.costUsd,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void markFailed({ id: intent.id, failureReason: msg });
    // error-level (not warn): a continuation failure silently bypasses the
    // character cache and the row regenerates from scratch, defeating identity
    // preservation. error-level surfaces in the Vercel error feed so a
    // dispatcher both-vendors-failed contradiction is caught the same day.
    logger.error('[gpt2-edit-failed pipeline character-continuation]', {
      character_id: characterId,
      detail: msg.slice(0, 200),
    });
    return { error: msg.slice(0, 200), durationMs: Date.now() - t0, costUsd: 0 };
  }
}

/** Phase 3 — generate a scene-continuation image via Atlas Edit on a
 *  cached scene base. Mirrors `generateCharacterContinuationImage` but
 *  uses the scene-continuation prompt (preserves location architecture
 *  / palette, NOT character face / hair). Same crop + upscale + R2-
 *  mirror chain so the caller doesn't have to special-case the post-
 *  Edit pipeline by anchor type.
 *
 *  Spec: _plans/2026-05-28-doodle-2-scene-cache.md. */
export async function generateSceneContinuationImage(args: {
  baseImageUrl: string;
  sceneId: string;
  newScenePrompt: string;
  /** Phase 2 (Character Bible) — prepended to the composed prompt so
   *  characters appearing in this scene-anchored row render with
   *  consistent reference language. */
  characterDescriptions?: Record<string, string>;
  /** Audit-row attribution for provider_generations. Optional for
   *  back-compat with legacy callers / tests; new code should always
   *  pass workspaceId. */
  workspaceId?: string | null;
  ownerId?: string | null;
}): Promise<PipelineImageResult> {
  const t0 = Date.now();
  const {
    baseImageUrl,
    sceneId,
    newScenePrompt,
    characterDescriptions,
    workspaceId = null,
    ownerId = null,
  } = args;
  if (!baseImageUrl.trim()) {
    return { error: 'empty_base_image_url', durationMs: Date.now() - t0, costUsd: 0 };
  }
  if (!sceneId.trim()) {
    return { error: 'empty_scene_id', durationMs: Date.now() - t0, costUsd: 0 };
  }
  if (!newScenePrompt.trim()) {
    return { error: 'empty_scene_prompt', durationMs: Date.now() - t0, costUsd: 0 };
  }

  const editPrompt = prependCharacterBible(
    buildSceneContinuationEditPrompt(newScenePrompt),
    characterDescriptions,
  );
  const ownerSettings = await getUserSettings(ownerId ?? '');
  const editPrimary = ownerSettings.gpt_image_2_edit_primary ?? 'atlas';
  const intent = await recordIntent({
    userId: ownerId,
    workspaceId,
    route: 'auto-pipeline:generateSceneContinuationImage',
    provider: editPrimary,
    providerModel: 'openai/gpt-image-2/edit',
  });
  try {
    const dispatched = await generateGptImage2Edit({
      prompt: editPrompt,
      sourceImageUrl: baseImageUrl,
      primary: editPrimary,
    });
    const upscale = await upscaleViaRecraft(dispatched.url);
    let finalUrl = upscale.url;
    try {
      const imgRes = await fetch(upscale.url);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const ext = contentType.includes('png') ? 'png' : 'jpg';
        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `prodoc-images/${Date.now()}-pipe-scene-continuation-${randomSuffix}.${ext}`;
        await uploadToBucket(bucket, r2Key, buffer, contentType);
        finalUrl = await getDownloadUrlForBucket(
          bucket,
          r2Key,
          process.env.R2_IMAGES_PUBLIC_URL,
        );
      }
    } catch (uploadErr) {
      logger.warn('[pipeline image-gen scene-continuation] R2 mirror failed, using upscale URL', {
        detail: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
      });
    }
    void markDelivered({
      id: intent.id,
      providerRequestId: dispatched.providerRequestId,
      responseUrl: finalUrl,
      costUsd: dispatched.costUsd,
      durationMs: dispatched.durationMs,
    });
    logger.info('[pipeline image-gen scene-continuation] succeeded', {
      scene_id: sceneId,
      vendor_used: dispatched.vendorUsed,
      fallback_used: dispatched.fallbackUsed,
      duration_ms: dispatched.durationMs,
      cost_usd: dispatched.costUsd,
    });
    return {
      imageUrl: finalUrl,
      durationMs: Date.now() - t0,
      modelUsed: 'openai/gpt-image-2/edit',
      costUsd: dispatched.costUsd,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void markFailed({ id: intent.id, failureReason: msg });
    // error-level: see generateCharacterContinuationImage's catch for the
    // rationale. Scene cache misses caused by silent Edit failures look
    // identical to fresh-row generations downstream, hiding the bug.
    logger.error('[gpt2-edit-failed pipeline scene-continuation]', {
      scene_id: sceneId,
      detail: msg.slice(0, 200),
    });
    return { error: msg.slice(0, 200), durationMs: Date.now() - t0, costUsd: 0 };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Auto-pipeline collage path (2026-05-28)
//
// Mirror of the manual `/api/generate/production-doc/collage` route, ported
// into the auto-pipeline so end-to-end videos pay the same ~75% cost
// reduction the manual bulk-gen button has had since 2026-05-26.
//
// Eligibility filter lives in the stage handler (one layer up) — this
// helper assumes its caller has already classified the 4 rows as
// collage-eligible (base row, no character/scene cache hit, no style refs,
// no per-row image_model override, no motion_beats / mouth_removed_url).
// Plan: _plans/2026-05-28-auto-pipeline-collage-port.md.
// ───────────────────────────────────────────────────────────────────────────

/** Per-cell input to `generateCollageGroup`. Mirrors the route's
 *  `CollageCellInput` shape exactly so the two paths share the same
 *  augmentation surface. */
export interface PipelineCollageCellInput {
  prompt: string;
  onScreenText?: string;
  onScreenTextMode?: 'bake' | 'overlay' | 'none';
  sectionTitle?: string;
  sectionTitleLayout?: 'overlay' | 'letterbox';
  styleSheetDescription?: string;
}

/** Per-cell outcome. One of these per cell in `results`. Shape matches
 *  `PipelineImageResult` so the caller can write each cell back to its
 *  row uniformly. */
export type PipelineCollageCellResult = PipelineImageResult;

export interface PipelineCollageGroupResult {
  /** Four per-cell results in the input order (i.e. the four-row chunk
   *  order). `imageUrl` set on success; `error` set on the few partial-
   *  failure paths (e.g. slice-and-upload error after a valid generation).
   *  In practice all 4 succeed-or-fail together — when the route reports
   *  malformed-after-retry the helper returns `fallbackNeeded: true` and
   *  the caller runs 4 single-shot calls instead. */
  results: [PipelineCollageCellResult, PipelineCollageCellResult, PipelineCollageCellResult, PipelineCollageCellResult];
  /** Aggregated cost across the 4 cells. Single Atlas T2I (~$0.011) +
   *  single Recraft Crisp Upscale (~$0.0025) ≈ $0.014 total ÷ 4 cells
   *  = $0.0035 per cell amortized. Reported as a single number on the
   *  group (not split across cells) so the caller's cost rollup logs
   *  cleanly attribute the saving. */
  totalCostUsd: number;
  /** True when the route's detect-malformed-after-retry tripped and the
   *  caller MUST fall back to 4 single-shot calls. When true, the
   *  `results` array contains 4 error entries with `reason` set to
   *  `malformed_after_retry`. */
  fallbackNeeded: boolean;
  /** Set when `fallbackNeeded === true`. Free-form short reason for
   *  the fallback (`malformed_after_retry` / `atlas_threw` / etc.) for
   *  the stage handler's telemetry. */
  reason?: string;
  /** Total wall-clock time for the helper, including the malformed
   *  retry if it fired. */
  durationMs: number;
}

/**
 * Generate a 4-up collage from 4 eligible base rows in one Atlas T2I call,
 * then slice into 4 per-row images. Mirrors `/api/generate/production-doc/
 * collage`'s happy-path branches inline — re-uses the same `composeCollagePrompt`
 * / `detectMalformedCollage` / `sliceCollage` helpers so behaviour stays in
 * sync with the manual path.
 *
 * The Atlas size is HARDCODED to `1536x1024`. Reasoning matches the route's
 * comment at /collage/route.ts:240-247: a 2560×1440 collage sliced into 4
 * quadrants yields only 1280×720 per shot (720p), below the per-shot resolution
 * target. The 1536×1024 source → Recraft 4× upscale → ~6144×3456 → 4 quadrants
 * of ~3072×1728 each (~3K per shot).
 *
 * Failure posture: never throws — returns `fallbackNeeded: true` so the
 * caller can route the 4 rows through the single-shot path on any failure
 * (malformed-after-retry, Atlas threw, slice errored). Stage-handler-level
 * idempotency (`if row.image_url skip`) handles partial writes.
 */
export async function generateCollageGroup(args: {
  cells: [PipelineCollageCellInput, PipelineCollageCellInput, PipelineCollageCellInput, PipelineCollageCellInput];
  /** Pass-through to `augmentCellPrompt` so collage cells inherit any
   *  doc-level character bible the per-row generation would also have
   *  carried. Equivalent to `doc.doodle_explainer_2_character_descriptions`. */
  characterDescriptions?: Record<string, string>;
  /** Audit-row attribution for provider_generations. Optional for
   *  back-compat with legacy callers / tests; production callers should
   *  always pass workspaceId so reconciliation can group by workspace. */
  workspaceId?: string | null;
  ownerId?: string | null;
  /** Refs-aware mode (2026-05-31, plan §C). When supplied, this collage
   *  is generated via Atlas i2i with the URLs as style anchors instead
   *  of the default Atlas t2i. The model treats every cell of the 2×2
   *  output as a child of the same style refs, preserving aesthetic
   *  consistency across cells. Used for styles whose `built_in_refs` /
   *  saved-style refs are load-bearing (doodle_explainer_2's hand-drawn
   *  doodle aesthetic depends on them). Pass an empty array or omit to
   *  use the original t2i path. Length capped at the Atlas i2i model's
   *  4-input limit; the caller is responsible for picking the most
   *  load-bearing refs when more are available.
   *  See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md` (C). */
  refImageUrls?: readonly string[];
}): Promise<PipelineCollageGroupResult> {
  const t0 = Date.now();
  const { cells, characterDescriptions, workspaceId = null, ownerId = null, refImageUrls } = args;
  const refsAware = Array.isArray(refImageUrls) && refImageUrls.length > 0;
  // Atlas i2i caps at 4 input images; cap defensively here so a caller
  // passing more (a saved-style with many refs) doesn't blow past the
  // model limit. First 4 in declared order — the caller decides the
  // priority order at load time.
  const ATLAS_I2I_MAX_REFS = 4;
  const cappedRefs = refsAware ? refImageUrls!.slice(0, ATLAS_I2I_MAX_REFS) : [];

  // ─── Augment each cell (mirrors /collage/route.ts:192-204) ────────────
  // augmentCellPrompt runs once; the directives are stable across the
  // two generation attempts. Only the composed scaffolding changes on
  // the reinforced retry.
  const augmented = cells.map((cell, index) =>
    augmentCellPrompt({
      prompt: cell.prompt,
      onScreenText: cell.onScreenText,
      onScreenTextMode: cell.onScreenTextMode,
      sectionTitle: cell.sectionTitle,
      sectionTitleLayout: cell.sectionTitleLayout,
      styleSheetDescription: cell.styleSheetDescription,
      characterDescriptions,
      promptCap: COLLAGE_CELL_PROMPT_CAP,
      source: `pipeline-collage-cell-${index}`,
    }),
  );
  const augmentedPrompts = augmented.map((a) => a.prompt);
  logger.info('[pipeline image-gen collage] cells composed', {
    cells: augmented.map((a, i) => ({
      index: i,
      ost_baked: a.ostBaked,
      safe_top: a.safeTop,
      sheet_desc: a.sheetDesc,
      truncated: a.truncated,
      augmented_len: a.prompt.length,
    })),
  });

  // ─── Try → detect malformed → retry once → fallback ───────────────────
  let upscaledUrl: string | null = null;
  let upscaledBytes: Buffer | null = null;
  let lastError: string | undefined;
  let malformedIndicesLast: number[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const composedPrompt = composeCollagePrompt(augmentedPrompts, attempt === 2);
    const attemptStart = Date.now();
    // One audit row per attempt — each is a separate paid Atlas T2I call.
    const attemptIntent = await recordIntent({
      userId: ownerId,
      workspaceId,
      route: 'auto-pipeline:generateCollageGroup',
      provider: 'atlas',
      providerModel: refsAware
        ? `openai/gpt-image-2/i2i#attempt-${attempt}`
        : `openai/gpt-image-2/t2i#attempt-${attempt}`,
    });
    let attemptProviderRequestId: string | null = null;
    try {
      logger.info('[pipeline image-gen collage] start', {
        attempt,
        prompt_chars: composedPrompt.length,
        refs_aware: refsAware,
        refs_sent: cappedRefs.length,
      });
      // 1536x1024 → cropTo16x9AndUpload → Recraft 4× upscale → ~6144×3456.
      // Refs-aware variant (2026-05-31, plan §C): Atlas i2i with the
      // style's refs as inputs. The model treats every cell of the 2×2
      // output as a child of the same style refs, preserving aesthetic
      // consistency. Otherwise falls back to the original t2i path.
      const atlasResult = refsAware
        ? await generateAtlasI2I({
            prompt: composedPrompt,
            images: cappedRefs,
            size: '1536x1024',
            quality: 'low',
          })
        : await generateAtlasT2I({
            prompt: composedPrompt,
            size: '1536x1024',
            quality: 'low',
          });
      attemptProviderRequestId = atlasResult.predictionId ?? null;
      const croppedUrl = await cropTo16x9AndUpload(atlasResult.url, 'prodoc-images-atlas-crop');
      const upscale = await upscaleViaRecraft(croppedUrl);
      const fetchRes = await fetch(upscale.url);
      if (!fetchRes.ok) {
        throw new Error(`Failed to fetch upscaled collage: HTTP ${fetchRes.status}`);
      }
      const buf = Buffer.from(await fetchRes.arrayBuffer());

      const detection = await detectMalformedCollage(buf);
      logger.info('[pipeline image-gen collage] attempt result', {
        attempt,
        all_valid: detection.allValid,
        malformed_indices: detection.malformedIndices,
        attempt_ms: Date.now() - attemptStart,
      });

      if (detection.allValid) {
        void markDelivered({
          id: attemptIntent.id,
          providerRequestId: attemptProviderRequestId,
          responseUrl: upscale.url,
          costUsd: 0.0135, // Atlas low (~$0.011) + Recraft (~$0.0025)
          durationMs: Date.now() - attemptStart,
        });
        upscaledUrl = upscale.url;
        upscaledBytes = buf;
        malformedIndicesLast = [];
        break;
      }
      // Malformed but charged. Mark failed so reconciliation surfaces
      // the wasted spend.
      void markFailed({
        id: attemptIntent.id,
        failureReason: `malformed_quadrants:${detection.malformedIndices.join(',')}`,
        providerRequestId: attemptProviderRequestId,
        durationMs: Date.now() - attemptStart,
      });
      malformedIndicesLast = detection.malformedIndices;
      if (attempt === 2) {
        lastError = 'malformed_after_retry';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void markFailed({
        id: attemptIntent.id,
        failureReason: msg,
        providerRequestId: attemptProviderRequestId,
        durationMs: Date.now() - attemptStart,
      });
      logger.error('[atlas-edit-failed pipeline collage]', {
        attempt,
        detail: msg.slice(0, 200),
      });
      if (attempt === 2) {
        lastError = `atlas_threw:${msg.slice(0, 100)}`;
      }
    }
  }

  if (upscaledUrl === null || upscaledBytes === null) {
    const errorReason = lastError ?? 'unknown';
    logger.warn('[pipeline image-gen collage] falling back to per-row singles', {
      reason: errorReason,
      malformed_indices: malformedIndicesLast,
    });
    const placeholder: PipelineCollageCellResult = {
      error: errorReason,
      durationMs: Date.now() - t0,
      costUsd: 0,
    };
    return {
      results: [placeholder, placeholder, placeholder, placeholder],
      totalCostUsd: 0,
      fallbackNeeded: true,
      reason: errorReason,
      durationMs: Date.now() - t0,
    };
  }

  // ─── Slice into 4 quadrants ───────────────────────────────────────────
  // sliceCollage fetches the upscaledUrl internally. We could pass the
  // bytes through to avoid the second fetch, but the slicer's signature
  // takes a URL and the savings aren't material (R2 GET on a hot key is
  // ~50ms). Skipping a refactor of the route's helper for parity.
  let sliceResult;
  try {
    sliceResult = await sliceCollage(upscaledUrl, { r2KeyPrefix: 'prodoc-images-collage' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[atlas-edit-failed pipeline collage-slice]', { detail: msg.slice(0, 200) });
    const placeholder: PipelineCollageCellResult = {
      error: `slice_failed:${msg.slice(0, 100)}`,
      durationMs: Date.now() - t0,
      costUsd: 0,
    };
    return {
      results: [placeholder, placeholder, placeholder, placeholder],
      totalCostUsd: 0,
      fallbackNeeded: true,
      reason: 'slice_failed',
      durationMs: Date.now() - t0,
    };
  }

  // ─── Success — wrap each quadrant URL in a per-cell result ────────────
  // Group cost: 1 × Atlas T2I ($0.011) + 1 × Recraft upscale ($0.0025) ≈
  // $0.014. Single-shot equivalent: 4 × ($0.011 + $0.0025) = $0.054.
  // Saving: ~74%. Cost reported as the group total; caller divides by 4
  // for per-row attribution if needed.
  const totalCostUsd = 0.014;
  const durationMs = Date.now() - t0;
  logger.info('[pipeline image-gen collage] succeeded', {
    quadrants: sliceResult.quadrantUrls.length,
    quadrant_dims: `${sliceResult.quadrantWidth}x${sliceResult.quadrantHeight}`,
    total_ms: durationMs,
    cost_usd: totalCostUsd,
  });
  return {
    results: [
      { imageUrl: sliceResult.quadrantUrls[0], durationMs, modelUsed: 'collage-atlas-t2i', costUsd: totalCostUsd / 4 },
      { imageUrl: sliceResult.quadrantUrls[1], durationMs, modelUsed: 'collage-atlas-t2i', costUsd: totalCostUsd / 4 },
      { imageUrl: sliceResult.quadrantUrls[2], durationMs, modelUsed: 'collage-atlas-t2i', costUsd: totalCostUsd / 4 },
      { imageUrl: sliceResult.quadrantUrls[3], durationMs, modelUsed: 'collage-atlas-t2i', costUsd: totalCostUsd / 4 },
    ],
    totalCostUsd,
    fallbackNeeded: false,
    durationMs,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// doodle_explainer_2 motion_collage (2026-05-31)
//
// Distinct from generateCollageGroup above (which packs FOUR unrelated
// shots into one image as a cost optimization). This helper generates ONE
// motion-collage shot whose N×M panels are PLAYED IN SEQUENCE by the
// renderer to produce real motion (a running character, falling object,
// logo assembly, …). The panels are drawn in one model call so visual
// coherence between frames is guaranteed.
//
// See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.
// ───────────────────────────────────────────────────────────────────────────

export interface PipelineMotionCollageResult {
  /** R2 URL of the raw N×M collage image (post-upscale). Kept for
   *  debugging + re-slice on settings change. Absent on validation or
   *  generation failure. */
  collageImageUrl?: string;
  /** R2 URLs of the per-panel slices, in row-major order. Length
   *  equals cols × rows on success. */
  panelUrls?: string[];
  /** Total cost across generation + upscale, in USD. Zero on a
   *  validation rejection (no AI call made). */
  costUsd: number;
  /** Wall-clock duration including all retries. */
  durationMs: number;
  /** Classified failure reason when `panelUrls` is absent.
   *  - `validation_failed:<detail>` — schema gate tripped before any
   *    AI call (caller surfaces in the inspector).
   *  - `settings_disabled` — doc-level `allow_motion_collage` is off.
   *  - `kill_switch` — env `MOTION_COLLAGE_ENABLED=false`.
   *  - `atlas_threw:<head>` — Atlas T2I errored.
   *  - `slice_failed:<head>` — sliceCollageGrid threw.
   *  - `slice_count_mismatch` — slice returned the wrong number of
   *    panels (defensive — bounds check should have caught it). */
  error?: string;
}

/**
 * Generate one motion-collage shot end-to-end: validate the row, call
 * Atlas T2I once with a same-scene-keyframes prompt, upscale via Recraft,
 * slice into the row's `cols × rows` panels, upload to R2. Returns the
 * panel URLs the caller writes onto the row.
 *
 * Failure posture: never throws — callers (the stage handler) want a
 * single per-row outcome, not a per-stage exception. Each failure mode
 * sets `error` to a classified short reason.
 *
 * The Atlas size is `1536×1024` (same as `generateCollageGroup`); after
 * `cropTo16x9AndUpload` and Recraft 4× upscale the slice source lands
 * at ~6144×3456. For a 4×4 grid that yields ~1536×864 per panel (HD),
 * matching the per-shot resolution target. Larger grids drop panel
 * resolution proportionally — that's a known cost of `MAX_COLLAGE_CELLS`
 * being 16. Documented in the architecture plan.
 *
 * Aspect-ratio caveat: non-square grids (e.g. 3×2) produce non-16:9
 * panels (1.185:1 in that case). The renderer's `objectFit: 'cover'`
 * crops them to fit a 16:9 frame, losing vertical content on landscape
 * grids and horizontal content on portrait grids. Acceptable for v1
 * since most motion is horizontal; documented in mixing_rules so the
 * LLM defaults to square grids (2×2 / 3×3 / 4×4) when in doubt.
 */
export async function generateMotionCollage(args: {
  row: PipelineImageRow;
  doc: PipelineImageDoc;
  workspaceId: string;
  ownerId?: string | null;
  /** When set, panel 0 is generated via Atlas Edit on this URL instead
   *  of a fresh Atlas i2i call. Used by the stage handler when the
   *  row carries a `character_id` or `scene_id` whose doc-level cache
   *  is populated — the cached base anchors identity across recurring
   *  rows, and the chained Edit propagation through panels 1..N
   *  preserves that anchor through the entire motion arc. Same
   *  ~$0.0135 cost as a fresh i2i. Caller is responsible for
   *  resolving precedence (character_cache wins over scene_cache,
   *  same rule as the regular single-shot dispatcher). */
  panel0SourceUrl?: string;
  /** Partial regeneration (PR 2 of
   *  `_plans/2026-06-02-editor-motion-collage-support.md`). When set,
   *  ONLY these panels are regenerated; every other panel is preserved
   *  from `existingPanelUrls`. Use cases:
   *    - User changed one panel's prompt and wants to re-roll just it
   *      without paying for N panels.
   *    - A single panel failed in a prior run and the user clicked
   *      "regen this panel" in the inspector.
   *  Constraints:
   *    - Every index must be in [0, N-1] where N = grid.cols × grid.rows.
   *    - When `panelIndices` is set, `existingPanelUrls` MUST be provided
   *      with length === N so the helper can pass through unrendered
   *      panels AND chain-edit from the right base when a middle panel
   *      regens (panel i's input is panel i-1's URL, which may be the
   *      existing one when i-1 is not being regen'd).
   *    - Chain semantics: regenerating panel K does NOT invalidate
   *      panels K+1..N. They keep their existing URLs. Visual
   *      continuity downstream of a partial regen may drift — the user
   *      explicitly chose partial regen and accepts that trade. To get
   *      full continuity they regen all panels.
   *  Undefined or empty array ⇒ legacy full-regen path. */
  panelIndices?: readonly number[];
  /** Existing panel URLs (length must equal grid.cols × grid.rows).
   *  Required when `panelIndices` is set; ignored otherwise. */
  existingPanelUrls?: readonly string[];
  /** 2026-06-09 — per-row image-model pick from the inspector's
   *  `ShotImageModelPicker`. A t2i model id (e.g. `'gpt-image-2-t2i'`
   *  for Kie). The helper resolves this through `resolveI2iModelForRow`
   *  to pick Atlas vs Kie for panel 0. When undefined → falls back to
   *  the style's `preferred_cloud_model` (existing Atlas-default
   *  behavior). */
  pickedModel?: string;
}): Promise<PipelineMotionCollageResult> {
  const t0 = Date.now();
  const {
    row,
    doc,
    workspaceId,
    ownerId = null,
    panel0SourceUrl,
    panelIndices,
    existingPanelUrls,
    pickedModel,
  } = args;

  // ─── 1. Env kill switch ─────────────────────────────────────────────
  // Lets us disable motion_collage globally without a redeploy if a
  // model regression breaks the feature. Default enabled — only the
  // literal string 'false' (case-insensitive) trips the gate.
  if ((process.env.MOTION_COLLAGE_ENABLED ?? '').toLowerCase() === 'false') {
    logger.warn('[motion-collage pipeline] kill-switch off — skipping', {
      env_value: process.env.MOTION_COLLAGE_ENABLED,
    });
    return {
      costUsd: 0,
      durationMs: Date.now() - t0,
      error: 'kill_switch',
    };
  }

  // ─── 2. Doc-level settings gate ─────────────────────────────────────
  // The LLM shouldn't have emitted motion_collage rows when the user
  // flipped this off (mixing_rules tells it), but defense in depth: the
  // pipeline refuses regardless of LLM emissions. Resolver inline — we
  // don't want to bring the resolver from utils.ts (React-pull). The
  // four settings carry sensible undefined → default fallback inline.
  const settings = doc.doodle_explainer_2_motion_collage_settings ?? {};
  const allowMotionCollage =
    typeof settings.allow_motion_collage === 'boolean' ? settings.allow_motion_collage : true;
  const maxGridPanelsRaw =
    typeof settings.max_grid_panels === 'number' && Number.isFinite(settings.max_grid_panels)
      ? settings.max_grid_panels
      : 12;
  const maxGridPanels = Math.max(4, Math.min(MAX_COLLAGE_CELLS, Math.round(maxGridPanelsRaw)));
  if (!allowMotionCollage) {
    logger.warn('[motion-collage pipeline] settings-disabled', {
      row_index: lookupRowIndex(row, doc),
    });
    return {
      costUsd: 0,
      durationMs: Date.now() - t0,
      error: 'settings_disabled',
    };
  }

  // ─── 3. Row validation ──────────────────────────────────────────────
  // Reject early — no AI call, no upload, no DB write — when the row's
  // motion_collage_* fields are malformed. Each branch logs a specific
  // reason the inspector / stage handler can surface.
  const grid = row.motion_collage_grid;
  if (
    !grid
    || !Number.isInteger(grid.cols)
    || !Number.isInteger(grid.rows)
    || grid.cols < 1
    || grid.rows < 1
  ) {
    logger.warn('[motion-collage pipeline] grid validation failed', {
      reason: 'grid_missing_or_malformed',
      grid,
    });
    return {
      costUsd: 0,
      durationMs: Date.now() - t0,
      error: 'validation_failed:grid_missing_or_malformed',
    };
  }
  const N = grid.cols * grid.rows;
  if (N > MAX_COLLAGE_CELLS) {
    logger.warn('[motion-collage pipeline] grid validation failed', {
      reason: 'grid_exceeds_hard_cap',
      cols: grid.cols,
      rows: grid.rows,
      cells: N,
      hard_cap: MAX_COLLAGE_CELLS,
    });
    return {
      costUsd: 0,
      durationMs: Date.now() - t0,
      error: `validation_failed:grid_exceeds_hard_cap:${N}>${MAX_COLLAGE_CELLS}`,
    };
  }
  if (N > maxGridPanels) {
    logger.warn('[motion-collage pipeline] grid validation failed', {
      reason: 'grid_exceeds_doc_setting',
      cols: grid.cols,
      rows: grid.rows,
      cells: N,
      doc_max: maxGridPanels,
    });
    return {
      costUsd: 0,
      durationMs: Date.now() - t0,
      error: `validation_failed:grid_exceeds_doc_setting:${N}>${maxGridPanels}`,
    };
  }
  const panelPrompts = row.motion_collage_panel_prompts;
  if (!Array.isArray(panelPrompts) || panelPrompts.length !== N) {
    logger.warn('[motion-collage pipeline] grid validation failed', {
      reason: 'panel_prompts_length_mismatch',
      expected: N,
      actual: Array.isArray(panelPrompts) ? panelPrompts.length : null,
    });
    return {
      costUsd: 0,
      durationMs: Date.now() - t0,
      error: 'validation_failed:panel_prompts_length_mismatch',
    };
  }
  if (panelPrompts.some((p) => typeof p !== 'string' || p.trim().length === 0)) {
    logger.warn('[motion-collage pipeline] grid validation failed', {
      reason: 'panel_prompt_empty',
    });
    return {
      costUsd: 0,
      durationMs: Date.now() - t0,
      error: 'validation_failed:panel_prompt_empty',
    };
  }
  // Per-panel character cap. Mirrors the existing prompt-augmentation
  // caps so the combined prompt doesn't blow past the model's context.
  const MAX_PER_PANEL_CHARS = 1500;
  if (panelPrompts.some((p) => p.length > MAX_PER_PANEL_CHARS)) {
    logger.warn('[motion-collage pipeline] grid validation failed', {
      reason: 'panel_prompt_too_long',
      max: MAX_PER_PANEL_CHARS,
    });
    return {
      costUsd: 0,
      durationMs: Date.now() - t0,
      error: `validation_failed:panel_prompt_too_long:max=${MAX_PER_PANEL_CHARS}`,
    };
  }

  // ─── 3.5 Partial-regen validation (PR 2 of motion-collage support) ───
  // `panelIndices` is the set of panels to regenerate; everything else
  // gets passed through from `existingPanelUrls`. Both inputs validated
  // before any AI call so a malformed request fails fast with $0 spent.
  const isPartialRegen = Array.isArray(panelIndices) && panelIndices.length > 0;
  let partialIndexSet: Set<number> | null = null;
  if (isPartialRegen) {
    // Index range + integer check.
    for (const idx of panelIndices!) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= N) {
        logger.warn('[motion-collage pipeline] partial-regen validation failed', {
          reason: 'panel_index_out_of_range',
          bad_index: idx,
          n: N,
        });
        return {
          costUsd: 0,
          durationMs: Date.now() - t0,
          error: `validation_failed:panel_index_out_of_range:${idx} not in [0,${N - 1}]`,
        };
      }
    }
    // Duplicates — silently dedupe via the Set, but the request should
    // not have included them in the first place. Log as a warning so a
    // misbehaving inspector doesn't slip past unnoticed.
    partialIndexSet = new Set(panelIndices);
    if (partialIndexSet.size !== panelIndices!.length) {
      logger.warn('[motion-collage pipeline] partial-regen has duplicates', {
        raw_count: panelIndices!.length,
        unique_count: partialIndexSet.size,
      });
    }
    // The existingPanelUrls array MUST be the full-length N so we can
    // pass through unselected panels. A partial array would mean "I
    // want to regen panel 3 and you fill in the blanks somehow" — no.
    if (!Array.isArray(existingPanelUrls) || existingPanelUrls.length !== N) {
      logger.warn('[motion-collage pipeline] partial-regen validation failed', {
        reason: 'existing_panel_urls_missing_or_wrong_length',
        expected_length: N,
        actual_length: Array.isArray(existingPanelUrls) ? existingPanelUrls.length : null,
      });
      return {
        costUsd: 0,
        durationMs: Date.now() - t0,
        error: 'validation_failed:existing_panel_urls_missing_or_wrong_length',
      };
    }
    // Every NON-regenerated slot needs a usable URL — otherwise the
    // chain math breaks ("regen panel 3" reads existingPanelUrls[2]
    // as the chain input, so [2] must be a real URL). HTTPS scheme
    // gate matches the project's other URL boundaries (rule 13:
    // never trust the client; cf. `isSafeAssetUrl` in payload.ts).
    for (let i = 0; i < N; i++) {
      if (partialIndexSet.has(i)) continue;
      const url = existingPanelUrls[i];
      if (
        typeof url !== 'string' ||
        url.length === 0 ||
        !(/^https:\/\//i.test(url) || url.startsWith('/'))
      ) {
        logger.warn('[motion-collage pipeline] partial-regen validation failed', {
          reason: 'existing_panel_url_unsafe',
          panel_index: i,
        });
        return {
          costUsd: 0,
          durationMs: Date.now() - t0,
          error: `validation_failed:existing_panel_url_unsafe:${i}`,
        };
      }
    }
    logger.info('[motion-collage pipeline] partial-regen scope', {
      n: N,
      regen_count: partialIndexSet.size,
      regen_indices: Array.from(partialIndexSet).sort((a, b) => a - b),
      passthrough_count: N - partialIndexSet.size,
    });
  }

  // ─── 4. Resolve style — suffix AND refs ──────────────────────────────
  // Refs are LOAD-BEARING for styles like doodle_explainer_2 — the
  // ai_image_suffix description alone won't reproduce the doodle look,
  // the 4 built-in refs are what teaches Atlas the stick-figure / thin
  // black ink lines / muted color palette aesthetic. Without refs the
  // model defaults to a generic illustration style — that's the bug
  // smoke-tested on the first motion_collage runs.
  // See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md` §C.
  let styleSuffix: string | undefined;
  // 2026-06-09 — lifted out so the panel-0 vendor decision (Atlas vs
  // Kie) sees it after this block. Wins behind row.image_model (the
  // inspector picker, plumbed in via `pickedModel`); falls back to
  // DEFAULT_CLOUD_I2I_MODEL via `resolveI2iModelForRow` when neither
  // is set.
  let stylePreferredCloudModel: string | null | undefined;
  let refImageUrls: string[] = [];
  if (doc.style_preset?.trim()) {
    try {
      const style = await resolveStyle(doc.style_preset, workspaceId, ownerId);
      styleSuffix = style?.ai_image_suffix;
      stylePreferredCloudModel = style?.preferred_cloud_model;
      if (style) {
        const refs = await loadStyleReferences(style.id, {
          excludeRejected: true,
          excludeUnvalidated: true,
          workspaceId,
        });
        if (refs.length > 0) {
          try {
            refImageUrls = await Promise.all(
              refs.map((r) =>
                r.public_url
                  ? mirrorPublicUrlRefToR2(r)
                  : getDownloadUrlForBucket(r.r2_bucket, r.r2_key, undefined),
              ),
            );
          } catch (refErr) {
            // Defensive — t2i fallback still produces SOMETHING (just
            // off-style). Better than a hard fail.
            logger.warn('[motion-collage pipeline] ref-url resolution failed — falling back to t2i', {
              error: refErr instanceof Error ? refErr.message : String(refErr),
            });
            refImageUrls = [];
          }
        }
      }
    } catch (err) {
      // Style lookup failure is non-fatal — the generation can still
      // run with the panel prompts alone. Logged for debugging.
      logger.warn('[motion-collage pipeline] style lookup failed — generating without suffix', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Channel-clone override: when the doc carries a per-job style
  // override, swap the preset's bundled refs with the channel's own
  // extracted frames. The suffix has already been baked into every
  // row's ai_image_prompt by the rowify stage so we don't need to
  // touch styleSuffix here. Same fall-back-on-error posture as the
  // preset path above.
  if (doc.channel_style_override && doc.channel_style_override.ref_r2_keys.length > 0) {
    try {
      const overrideBucket = getReviewBucket();
      refImageUrls = await Promise.all(
        doc.channel_style_override.ref_r2_keys.map((r2Key) =>
          getDownloadUrlForBucket(overrideBucket, r2Key, undefined),
        ),
      );
      logger.info('[motion-collage pipeline] using channel-clone override refs', {
        refCount: refImageUrls.length,
      });
    } catch (overrideErr) {
      logger.warn('[motion-collage pipeline] channel-override ref resolution failed — falling back to preset refs', {
        error: overrideErr instanceof Error ? overrideErr.message : String(overrideErr),
      });
      // Keep whatever refImageUrls the preset path produced.
    }
  }

  // ─── 5. Chained Atlas Edit generation (plan §E, 2026-05-31) ─────────
  //
  // Earlier iteration (plan §D, parallel per-panel) fixed the muddy
  // output but BROKE continuity — 4 independent Atlas i2i calls
  // produced 4 unrelated scenes (different ships, different characters,
  // different camera angles). Refs + "same scene" prompt language were
  // not enough to lock visual continuity across independent generations.
  //
  // The fix: generate panel 0 with Atlas i2i + refs (creates the base
  // composition), then chain Atlas Edit for panels 1..N — each panel
  // takes the PREVIOUS panel's URL as input and applies a delta. Atlas
  // Edit preserves the input image's identity (ship, characters, camera,
  // background) while modifying only what the panel prompt requests.
  // Result: every panel literally builds on the prior one, giving real
  // motion-arc continuity.
  //
  // Cost stays ~$0.054 per 4-panel shot (Atlas Edit ~$0.011 same as
  // i2i). Trade-off: chained, so 4 panels run sequentially — total
  // wall-clock ~2 min instead of parallel §D's ~30s. Acceptable.
  // Drift: ~5% per chained step used to compound across the chain;
  // mitigated 2026-06-02 by the DUAL-INPUT panel call (panel K-1 as
  // primary input for motion continuity + panel 0 as second input for
  // composition anchor) — see the per-panel loop below.
  const ATLAS_I2I_MAX_REFS = 4;
  const refsAware = refImageUrls.length > 0;
  const cappedRefs = refsAware ? refImageUrls.slice(0, ATLAS_I2I_MAX_REFS) : [];

  // ─── Vendor decision (Atlas vs Kie) ─────────────────────────────────
  // 2026-06-09 — the inspector's `ShotImageModelPicker` writes the row's
  // chosen t2i model id to `pickedModel`. `resolveI2iModelForRow` maps
  // it to an i2i counterpart (e.g. `gpt-image-2-t2i` → `gpt-image-2-i2i`
  // for the Kie pair, `gpt-image-2-atlas-t2i` → `gpt-image-2-atlas-i2i`
  // for the Atlas pair), with fall-through to the style's preferred
  // model and then DEFAULT_CLOUD_I2I_MODEL.
  //
  // The vendor is what actually decides which API gets called for panel 0
  // and which Edit primary the chained panels 1..N use. Before this
  // motion-collage was hardcoded to Atlas regardless of the picker — the
  // bug that turned every motion-collage row red the day the Atlas
  // account balance hit zero.
  const resolvedI2i = resolveI2iModelForRow({
    rowPickedModel: pickedModel,
    stylePreferred: stylePreferredCloudModel,
  });
  const resolvedI2iSpec = getI2IModelSpec(resolvedI2i.i2iModel);
  const panel0Vendor: 'atlas' | 'kie' =
    resolvedI2iSpec?.provider === 'kie' ? 'kie' : 'atlas';

  logger.info('[motion-collage pipeline] start', {
    row_index: lookupRowIndex(row, doc),
    grid: `${grid.cols}x${grid.rows}`,
    panel_count: N,
    mode: 'chained-edit',
    refs_aware: refsAware,
    refs_sent: cappedRefs.length,
    panel_0_vendor: panel0Vendor,
    picked_model: pickedModel ?? null,
    resolved_i2i_model: resolvedI2i.i2iModel,
    model_source: resolvedI2i.source,
  });

  // Compose panel 0's prompt with full style directives + sparseness
  // rules; the base sets the scene. Panels 1..N use the raw panel
  // prompts (the LLM's "Same scene; only X advances" wording is exactly
  // what Atlas Edit needs — describes what changes, lets the input image
  // carry the rest).
  const characterDescriptions = doc.doodle_explainer_2_character_descriptions;
  const panel0Prompt = composePerPanelPrompt({
    panelPrompt: panelPrompts[0],
    panelIndex: 0,
    totalPanels: N,
    characterDescriptions,
    styleSuffix,
  });

  const panelResults: Array<{ url?: string; error?: string; costUsd: number; durationMs: number }> =
    new Array(N);
  for (let i = 0; i < N; i++) panelResults[i] = { costUsd: 0, durationMs: 0 };

  // ─── Panel 0 — Atlas i2i with refs OR Atlas Edit on cache hit ──────
  // Three routing modes:
  //   1. panel0SourceUrl set → Atlas Edit on the cached base. Used
  //      when stage handler resolved a character_cache or scene_cache
  //      hit, preserving identity across non-consecutive rows.
  //   2. refsAware → Atlas i2i with the 4 style refs. Default for
  //      doodle_explainer_2 fresh shots.
  //   3. Neither → Atlas t2i with suffix only (refs-less styles).
  const panel0FromCache = typeof panel0SourceUrl === 'string' && panel0SourceUrl.length > 0;
  let previousPanelUrl: string | undefined;
  // Partial regen path: panel 0 is NOT in the regen set ⇒ pass through
  // its existing URL straight into the result + use it as the chain
  // base for downstream panels. No AI call, no cost. Panel 0 IS in the
  // regen set ⇒ fall through to the normal generation block below.
  const skipPanel0 = isPartialRegen && partialIndexSet !== null && !partialIndexSet.has(0);
  if (skipPanel0) {
    const passthroughUrl = existingPanelUrls![0];
    panelResults[0] = {
      url: passthroughUrl,
      costUsd: 0,
      durationMs: 0,
    };
    previousPanelUrl = passthroughUrl;
    logger.info('[motion-collage pipeline] panel passthrough', {
      row_index: lookupRowIndex(row, doc),
      panel_index: 0,
      of_total: N,
      url: passthroughUrl,
    });
  }
  if (!skipPanel0) {
    const panelStart = Date.now();
    const intent = await recordIntent({
      userId: ownerId,
      workspaceId,
      route: 'auto-pipeline:generateMotionCollage#panel-0-base',
      provider: panel0Vendor,
      providerModel: panel0FromCache
        ? `openai/gpt-image-2/edit#motion-collage-base-cached-${grid.cols}x${grid.rows}-${panel0Vendor}`
        : refsAware
        ? `openai/gpt-image-2/i2i#motion-collage-base-${grid.cols}x${grid.rows}-${panel0Vendor}`
        : `openai/gpt-image-2/t2i#motion-collage-base-${grid.cols}x${grid.rows}-${panel0Vendor}`,
    });
    let providerRequestId: string | null = null;
    try {
      let atlasUrl: string;
      let atlasPredictionId: string | null = null;
      if (panel0FromCache) {
        // Edit on the cached base. `generateGptImage2Edit` handles both
        // Atlas and Kie via the `primary` field, with automatic vendor
        // fallback on failure (see `_plans/2026-05-29-gpt-image-2-edit-
        // provider-fallback.md`). When the picker pointed at Kie, Edit
        // primary is Kie; when at Atlas (or unset), Atlas.
        const edit = await generateGptImage2Edit({
          prompt: panel0Prompt,
          sourceImageUrl: panel0SourceUrl!,
          primary: panel0Vendor,
        });
        atlasUrl = edit.url;
        atlasPredictionId = edit.providerRequestId;
      } else if (refsAware && panel0Vendor === 'atlas') {
        // Native 16:9 — Atlas's 2560×1440 is one of four supported sizes
        // (see `AtlasSize` in atlas-cloud-images.ts) and matches the
        // 1920×1080 canvas exactly with zero post-crop. Was previously
        // 1536×1024 (3:2) → cropTo16x9AndUpload, which destroyed ~7.8%
        // off the top + bottom of every panel — the user repeatedly hit
        // labels and characters clipped at the top edge in motion-
        // collage rows because the AI placed them where the crop would
        // land. Plan: 2026-06-08-motion-collage-native-16x9.md.
        const atlasResult = await generateAtlasI2I({
          prompt: panel0Prompt,
          images: cappedRefs,
          size: '2560x1440',
          quality: 'low',
        });
        atlasUrl = atlasResult.url;
        atlasPredictionId = atlasResult.predictionId ?? null;
      } else if (refsAware && panel0Vendor === 'kie') {
        // Kie i2i via `gpt-image-2-image-to-image`. Native 16:9 at 1K
        // (1024×576). Recraft upscale runs downstream (1024 < 2000 px
        // threshold) so the final lands at ~4K, plenty for the 1080p
        // renderer canvas. Added 2026-06-09 so the picker's "GPT Image
        // 2 (Kie)" choice actually routes through Kie for motion-collage
        // panel 0 (previously the choice was discarded — see
        // `_plans/2026-06-09-motion-collage-panel-1-r2-mirror-and-smaller-deltas.md`).
        const apiKey = process.env.KIE_API_KEY;
        if (!apiKey) {
          throw new Error('KIE_API_KEY is not configured');
        }
        const taskId = await createKieTask(apiKey, 'gpt-image-2-image-to-image', {
          prompt: panel0Prompt,
          input_urls: cappedRefs,
          aspect_ratio: '16:9',
          resolution: '1K',
        });
        atlasUrl = await pollKieResult(taskId, apiKey);
        atlasPredictionId = taskId;
      } else if (panel0Vendor === 'atlas') {
        const atlasResult = await generateAtlasT2I({
          prompt: panel0Prompt,
          size: '2560x1440',
          quality: 'low',
        });
        atlasUrl = atlasResult.url;
        atlasPredictionId = atlasResult.predictionId ?? null;
      } else {
        // Kie t2i via `gpt-image-2-text-to-image`. Same shape as the i2i
        // branch above but without input_urls.
        const apiKey = process.env.KIE_API_KEY;
        if (!apiKey) {
          throw new Error('KIE_API_KEY is not configured');
        }
        const taskId = await createKieTask(apiKey, 'gpt-image-2-text-to-image', {
          prompt: panel0Prompt,
          aspect_ratio: '16:9',
          resolution: '1K',
        });
        atlasUrl = await pollKieResult(taskId, apiKey);
        atlasPredictionId = taskId;
      }
      providerRequestId = atlasPredictionId;
      // Native 16:9 source — no crop needed. But we DO need to persist
      // the bytes to R2: Atlas CDN URLs are ephemeral and the upscale
      // step's "skip if > 2000px long edge" guard means it would
      // otherwise return the raw Atlas URL unchanged, which expires
      // hours later and turns panel 1 into a broken image in the
      // editor (the lightbox's `<img alt>` falls back to "Panel 1 of N"
      // text, the symptom the user reported 2026-06-09). The
      // `panel0FromCache` branch already persists via
      // generateGptImage2Edit → cropToAspectAndUpload, so it short-
      // circuits the mirror here. See plan:
      // _plans/2026-06-09-motion-collage-panel-1-r2-mirror-and-smaller-deltas.md
      let mirroredUrl: string;
      if (panel0FromCache) {
        // Edit's `atlasUrl` is already a persistent R2 URL — skip the
        // redundant mirror so we don't pay for an extra fetch + upload.
        mirroredUrl = atlasUrl;
        logger.info('[motion-collage panel-0-mirror] skip cache-edit-already-r2', {
          row_index: lookupRowIndex(row, doc),
        });
      } else {
        const mirrorStart = Date.now();
        mirroredUrl = await mirrorImageToR2(atlasUrl, 'prodoc-images-motion-collage-panel-0');
        logger.info('[motion-collage panel-0-mirror] done', {
          row_index: lookupRowIndex(row, doc),
          src_url_preview: atlasUrl.slice(0, 80),
          r2_url_preview: mirroredUrl.slice(0, 80),
          ms: Date.now() - mirrorStart,
        });
      }
      const croppedUrl = mirroredUrl;
      const upscale = await upscaleViaRecraft(croppedUrl);
      const panelDurationMs = Date.now() - panelStart;
      const panelCostUsd = 0.0135;
      void markDelivered({
        id: intent.id,
        providerRequestId,
        responseUrl: upscale.url,
        costUsd: panelCostUsd,
        durationMs: panelDurationMs,
      });
      panelResults[0] = { url: upscale.url, costUsd: panelCostUsd, durationMs: panelDurationMs };
      previousPanelUrl = upscale.url;
      logger.info('[motion-collage pipeline] panel done', {
        row_index: lookupRowIndex(row, doc),
        panel_index: 0,
        of_total: N,
        kind: panel0FromCache ? 'base-edit-on-cache' : refsAware ? 'base-i2i' : 'base-t2i',
        url: upscale.url,
        ms: panelDurationMs,
        cost_usd: panelCostUsd,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const panelDurationMs = Date.now() - panelStart;
      void markFailed({
        id: intent.id,
        failureReason: msg,
        providerRequestId,
        durationMs: panelDurationMs,
      });
      panelResults[0] = {
        error: `panel_0_threw:${msg.slice(0, 80)}`,
        costUsd: 0,
        durationMs: panelDurationMs,
      };
      logger.error('[motion-collage pipeline] panel failed', {
        row_index: lookupRowIndex(row, doc),
        panel_index: 0,
        of_total: N,
        kind: panel0FromCache ? 'base-edit-on-cache' : refsAware ? 'base-i2i' : 'base-t2i',
        detail: msg.slice(0, 200),
      });
    }
  }

  // ─── Panels 1..N — dual-input chained Atlas Edit ───────────────────
  // Each call passes TWO images to Atlas Edit:
  //   1. PRIMARY input = previous panel — supplies motion continuity
  //      (the moving element's position last frame; the model interpolates
  //      smoothly to this frame's position).
  //   2. SECOND input = panel 0 — supplies the composition anchor (every
  //      static element keeps its panel-0 size + position). Panel 0 is
  //      passed via `extraImageUrls`; the prompt spells out which input
  //      is which so the model uses them correctly.
  // For panel 1 the previous panel IS panel 0, so the second input would
  // be a duplicate — we skip the extra image in that case.
  //
  // Why dual-input: single-source chained Edit on the previous panel gave
  // smooth motion but composition drifted ~5% per step (sticky notes
  // wandered, prop scales ramped up). Always-from-base-0 locked composition
  // but each panel imagined element position independently → jumpy motion.
  // Dual-input gives BOTH: motion continuity from input 1, layout lock
  // from input 2. See user feedback 2026-06-02 + the framing-lock
  // explainer below.
  //
  // Sequential because each step depends on the previous panel's URL.
  // Character bible block — built once, reused across every chained
  // edit prompt. Without this, panels 1..N rely solely on whatever
  // appearance the previous image already carries; if the LLM panel
  // prompt mentions a character by slug ("George raises his arm"),
  // Atlas Edit needs the bible context to keep George visually
  // consistent. Empty string when the doc has no bible.
  const chainBibleBlock = buildCharacterBibleBlock(characterDescriptions);
  // Panel 0's URL is the composition anchor for panels 2..N-1. Read
  // from the result slot (handles regen passthrough + fresh generation
  // uniformly). When panel 0 failed, this stays undefined and the
  // chain bails out anyway via the existing previousPanelUrl guard.
  const panel0AnchorUrl = panelResults[0]?.url;
  for (let panelIdx = 1; panelIdx < N; panelIdx++) {
    // Partial regen passthrough: panel not in the regen set keeps its
    // existing URL and becomes the chain base for the NEXT panel.
    // Cost stays 0; no AI call. Logged for parity with the regen path.
    if (
      isPartialRegen &&
      partialIndexSet !== null &&
      !partialIndexSet.has(panelIdx)
    ) {
      const passthroughUrl = existingPanelUrls![panelIdx];
      panelResults[panelIdx] = {
        url: passthroughUrl,
        costUsd: 0,
        durationMs: 0,
      };
      previousPanelUrl = passthroughUrl;
      logger.info('[motion-collage pipeline] panel passthrough', {
        row_index: lookupRowIndex(row, doc),
        panel_index: panelIdx,
        of_total: N,
        url: passthroughUrl,
      });
      continue;
    }
    if (!previousPanelUrl) {
      // Panel 0 failed — propagate the failure through every later
      // panel without making any AI calls.
      panelResults[panelIdx] = {
        error: 'skipped:base_panel_failed',
        costUsd: 0,
        durationMs: 0,
      };
      continue;
    }
    const panelStart = Date.now();
    // PR4 (2026-06-03) — chain depth cap. Panels 1..MAX_CHAIN_DEPTH-1
    // chain off the previous panel (dual-input with panel 0 anchor for
    // panel idx >= 2). Panels at index MAX_CHAIN_DEPTH and beyond anchor
    // DIRECTLY to panel 0 with NO previous-panel dependency. The chain
    // becomes a fan-out from panel 0 instead of a straight line, which
    // eliminates compounding drift past the 4th step.
    const useChainedSource = panelIdx < MOTION_COLLAGE_MAX_CHAIN_DEPTH;
    // PR4: scrub scale/size verbs before they reach Atlas. The
    // composer-level scrub catches grid prompts; this catches the
    // per-panel descriptions feeding the chained dual-input loop.
    const baseDelta = scrubScaleVerbs(panelPrompts[panelIdx]).text;
    const hasCompositionAnchor =
      useChainedSource
      && panelIdx >= 2
      && typeof panel0AnchorUrl === 'string'
      && panel0AnchorUrl !== previousPanelUrl;
    // For anchored (non-chained) panels, the SOURCE image IS panel 0 —
    // no previous panel involved. For chained panels, source = previous,
    // and panel 0 may be passed as the second image when panelIdx >= 2.
    const effectiveSourceUrl = useChainedSource ? previousPanelUrl : panel0AnchorUrl;
    if (!effectiveSourceUrl) {
      // Panel 0 is missing (chain entirely broken) — bail this panel.
      panelResults[panelIdx] = {
        error: 'skipped:source_url_unavailable',
        costUsd: 0,
        durationMs: 0,
      };
      continue;
    }
    // FRAMING + SCALE LOCK: the #1 motion_collage failure mode is the
    // model treating "the warning gets bigger" as a license to scale the
    // prop frame by frame. This clause forbids it explicitly + locks the
    // camera. Reinforced for deep chains where panel 0 anchors composition
    // via the second input image (see the dual-input directive below).
    const framingLock =
      'CRITICAL FRAMING + SCALE CONSTRAINT: Reproduce the previous-frame composition exactly. Every subject — character, sticky note, sign, icon, label, prop, background element — keeps the SAME SIZE, the SAME vertical position, and the SAME horizontal position as the input. Do NOT crop, zoom, pan, scale, enlarge, shrink, or otherwise resize any element. If the panel description below says an element "grows" or "gets larger", DISREGARD that and instead translate, rotate, or progressively draw the element — never resize it. Only the moving element\'s POSITION / ROTATION / POSE should differ.';
    let inputDirective: string;
    if (!useChainedSource) {
      // PR4 fan-out branch — single input = panel 0 (the composition
      // anchor). The chain doesn't see the previous panel here, so the
      // motion arc between adjacent anchored panels is choppier; the
      // composition stays locked verbatim to panel 0 which is the
      // tradeoff the user asked for.
      inputDirective =
        'COMPOSITION ANCHOR INPUT — this is panel 0, the canonical layout for the entire grid. Every static element (sticky notes, character, background, props) must match its position, size, rotation, and shape in the input EXACTLY. Render the moving element at THIS frame\'s position as described below. Treat this as a fresh edit of the original frame at the position described — do not interpolate from any previous frame, draw the position as written.';
    } else if (hasCompositionAnchor) {
      inputDirective =
        'DUAL INPUT — read carefully: the FIRST input image is the PREVIOUS FRAME (use it to see where the moving element was last frame so this frame\'s position interpolates smoothly). The SECOND input image is the ORIGINAL COMPOSITION ANCHOR (panel 0). Every STATIC element — sticky notes, character, background, props that are not moving — must match its position, size, rotation, and shape in the SECOND input EXACTLY. If the first input shows drift (e.g. a sticky note moved 10px from panel 0), trust the SECOND input — that is the ground truth for static layout.';
    } else {
      inputDirective =
        'Preserve the input image\'s composition, character identity, camera angle, and background exactly. Only modify the moving element to match the description below.';
    }
    const editPrompt = [
      framingLock,
      inputDirective,
      chainBibleBlock,
      baseDelta,
      'Keep the hand-drawn doodle aesthetic: thin black ink lines, sparse composition, generous white space. Do NOT add details or shading not present in the input image(s).',
    ].filter(Boolean).join('\n\n');
    const intent = await recordIntent({
      userId: ownerId,
      workspaceId,
      route: `auto-pipeline:generateMotionCollage#panel-${panelIdx}-edit`,
      provider: 'atlas',
      providerModel: `openai/gpt-image-2/edit#motion-collage-panel-${panelIdx + 1}-of-${N}`,
    });
    let providerRequestId: string | null = null;
    try {
      const edit = await generateGptImage2Edit({
        prompt: editPrompt,
        sourceImageUrl: effectiveSourceUrl,
        // Anchored (non-chained) panels source from panel 0 directly,
        // so there's no SECOND input to pass — the source IS the anchor.
        extraImageUrls: hasCompositionAnchor ? [panel0AnchorUrl!] : [],
        // 2026-06-09 — track the row's vendor pick through the chain so
        // a Kie-picked row stays on Kie for every panel, and an Atlas-
        // picked row stays on Atlas. `generateGptImage2Edit` already
        // has automatic primary→fallback (Atlas→Kie or Kie→Atlas), so
        // a transient outage doesn't break the whole row.
        primary: panel0Vendor,
      });
      providerRequestId = edit.providerRequestId;
      const upscale = await upscaleViaRecraft(edit.url);
      const panelDurationMs = Date.now() - panelStart;
      const panelCostUsd = edit.costUsd + 0.0025; // Atlas Edit + Recraft
      void markDelivered({
        id: intent.id,
        providerRequestId,
        responseUrl: upscale.url,
        costUsd: panelCostUsd,
        durationMs: panelDurationMs,
      });
      panelResults[panelIdx] = {
        url: upscale.url,
        costUsd: panelCostUsd,
        durationMs: panelDurationMs,
      };
      // Only update previousPanelUrl when we're still chaining. For
      // anchored (fan-out) panels, "previous" is irrelevant — every
      // anchored panel reads from panel 0 directly.
      if (useChainedSource) {
        previousPanelUrl = upscale.url;
      }
      logger.info('[motion-collage chain-strategy]', {
        row_index: lookupRowIndex(row, doc),
        panel_index: panelIdx,
        of_total: N,
        strategy: useChainedSource ? (hasCompositionAnchor ? 'chained-dual-input' : 'chained-single-input') : 'anchored-to-panel-0',
        max_chain_depth: MOTION_COLLAGE_MAX_CHAIN_DEPTH,
        vendor_used: edit.vendorUsed,
        fallback_used: edit.fallbackUsed,
        url: upscale.url,
        ms: panelDurationMs,
        cost_usd: panelCostUsd,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const panelDurationMs = Date.now() - panelStart;
      void markFailed({
        id: intent.id,
        failureReason: msg,
        providerRequestId,
        durationMs: panelDurationMs,
      });
      panelResults[panelIdx] = {
        error: `panel_${panelIdx}_threw:${msg.slice(0, 80)}`,
        costUsd: 0,
        durationMs: panelDurationMs,
      };
      logger.error('[motion-collage pipeline] panel failed', {
        row_index: lookupRowIndex(row, doc),
        panel_index: panelIdx,
        of_total: N,
        kind: useChainedSource ? 'chained-edit' : 'anchored-to-panel-0',
        detail: msg.slice(0, 200),
      });
      // Don't continue chain on failure — the next CHAINED panel would
      // need a non-existent prior URL. Anchored panels read from
      // panel 0 directly, so a chain failure doesn't poison them.
      if (useChainedSource) {
        previousPanelUrl = undefined;
      }
    }
  }

  // Aggregate results. If ANY panel failed, fail the whole row — the
  // renderer needs the full set of N panels to play the keyframe
  // sequence, and partial sets are visually broken (gap in the
  // animation). User can retry from the inspector.
  const totalCostUsd = panelResults.reduce((sum, p) => sum + p.costUsd, 0);
  const failedPanels = panelResults
    .map((p, i) => (p.error ? { i, err: p.error } : null))
    .filter((x): x is { i: number; err: string } => x !== null);
  if (failedPanels.length > 0) {
    logger.error('[motion-collage pipeline] one or more panels failed', {
      row_index: lookupRowIndex(row, doc),
      failed_panel_indices: failedPanels.map((f) => f.i),
      total_cost_usd: totalCostUsd,
    });
    return {
      costUsd: totalCostUsd,
      durationMs: Date.now() - t0,
      error: `panels_failed:${failedPanels.map((f) => f.i).join(',')}`,
    };
  }

  const panelUrls = panelResults.map((p) => p.url!);

  logger.info('[motion-collage pipeline] all panels done', {
    row_index: lookupRowIndex(row, doc),
    grid: `${grid.cols}x${grid.rows}`,
    panel_count: panelUrls.length,
    total_ms: Date.now() - t0,
    total_cost_usd: totalCostUsd,
  });

  return {
    // Pre-§D this carried the raw N×M collage. Per-panel generation
    // doesn't produce one — set to panel[0] so legacy callers reading
    // this field for a thumbnail get the first frame.
    collageImageUrl: panelUrls[0],
    panelUrls,
    costUsd: totalCostUsd,
    durationMs: Date.now() - t0,
  };
}

/** Find a row's index in the doc for log attribution. Returns -1 when
 *  the row isn't actually in the doc (defensive — shouldn't happen in
 *  the pipeline path). Used purely for telemetry; never affects
 *  control flow. */
function lookupRowIndex(row: PipelineImageRow, doc: PipelineImageDoc): number {
  return doc.rows.findIndex((r) => r === row);
}

/** Pick a per-row slice from the channel-style ref pool. The pool is
 *  typically 12 frames (per deriveChannelStyle's TARGET_REF_COUNT);
 *  Atlas i2i takes 4. We rotate the window through the pool with a
 *  2-frame stride so adjacent rows share two anchors (continuity
 *  between scenes) while distant rows pull entirely different frames
 *  (visual variety across the doc). When the pool is smaller than
 *  the slice size, returns the whole pool unchanged.
 *
 *  Exported for unit tests; called from generateBaseImage. 2026-06-08. */
export function pickPerRowRefSlice(
  pool: string[],
  rowIndex: number,
  sliceSize: number,
): string[] {
  if (pool.length === 0) return [];
  if (pool.length <= sliceSize) return [...pool];
  // Negative or unknown index falls back to the head of the pool.
  const safeIndex = rowIndex < 0 ? 0 : rowIndex;
  const startStride = 2;
  const start = (safeIndex * startStride) % pool.length;
  const slice: string[] = [];
  for (let i = 0; i < sliceSize; i += 1) {
    slice.push(pool[(start + i) % pool.length]);
  }
  return slice;
}

/**
 * Eligibility check: is this row safe to send through the auto-pipeline
 * collage path? Exported so the stage handler (one layer up) can build
 * its work units before any DB write.
 *
 * Excludes:
 *  1. Variants (variant_index > 0) — Edit-path, not T2I.
 *  2. Rows with a character_id that has a cache hit — Atlas Edit on the
 *     cached base preserves identity better than a fresh collage cell.
 *  3. Rows with a scene_id that has a cache hit — same reasoning, location.
 *  4. Rows with a populated `mouth_removed_url` — paint_explainer_v1's
 *     MouthSwap overlay requires a single coherent base frame; a sliced
 *     collage quadrant would not align with the mouth-removed asset.
 *  5. Rows with non-empty `motion_beats` — paint_explainer_v1 motion beats
 *     are Atlas Edit sibling frames built FROM the base; the base must
 *     exist as a single coherent frame the variants can edit. A collage
 *     quadrant is too low-resolution / contextually polluted to serve.
 *  6. Styled docs with loaded refs — the collage route is t2i-only and
 *     drops refs; bypassing it preserves style consistency. (Style preset
 *     name passed in; refs presence checked by caller via existing
 *     `loadStyleReferences`.)
 *  7. Rows with a non-empty `ai_image_prompt` (defensive — caller should
 *     have filtered, but no harm checking again).
 *
 * Doesn't check `image_url` (caller has already filtered to empty rows)
 * or `variant_derives_from_previous` (only meaningful for variants, which
 * are excluded by rule 1). Doesn't load style refs (async, route through
 * caller).
 */
export function isCollageEligibleRow(
  row: PipelineImageRow,
  doc: PipelineImageDoc,
  styleHasRefs: boolean,
): { eligible: boolean; reason?: 'variant' | 'character_cache' | 'scene_cache' | 'mouth_removed' | 'motion_beats' | 'style_refs' | 'no_prompt' } {
  if ((row.variant_index ?? 0) !== 0) {
    return { eligible: false, reason: 'variant' };
  }
  if (!row.ai_image_prompt?.trim()) {
    return { eligible: false, reason: 'no_prompt' };
  }
  if (row.character_id) {
    const cached = doc.doodle_explainer_2_character_cache?.[row.character_id];
    if (cached?.base_url) {
      return { eligible: false, reason: 'character_cache' };
    }
  }
  if (row.scene_id) {
    const cached = doc.doodle_explainer_2_scene_cache?.[row.scene_id];
    if (cached?.base_url) {
      return { eligible: false, reason: 'scene_cache' };
    }
  }
  if (row.mouth_removed_url?.trim()) {
    return { eligible: false, reason: 'mouth_removed' };
  }
  if (row.motion_beats && row.motion_beats.length > 0) {
    return { eligible: false, reason: 'motion_beats' };
  }
  // 2026-05-31 (plan §C, refs-aware collage): styles with refs are no
  // longer excluded. The stage handler now branches on `styleHasRefs`
  // at the collage call site — refs-bearing styles route to
  // generateCollageGroup with `refImageUrls` populated (Atlas i2i),
  // refs-less styles route to the original t2i path. The
  // `styleHasRefs` argument stays in the signature so older
  // callers / tests don't break; it's now informational only.
  void styleHasRefs;
  return { eligible: true };
}

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
import { loadStyleReferences } from '../production-doc-styles-refs';
import { generateImageWithRefs, ReferenceRejectedError } from '../image-gen-i2i';
import { DEFAULT_CLOUD_I2I_MODEL, getI2IModelSpec } from '../image-models-i2i';
import { generateAtlasT2I } from './../atlas-cloud-images';
import { generateGptImage2Edit } from '../gpt-image-2-edit';
import { getUserSettings } from '../user-settings';
import { composeCollagePrompt } from '../collage-prompt';
import { detectMalformedCollage } from '../collage-detect';
import { sliceCollage } from '../collage-slicer';
import { generateMouthRemovedBase } from '../atlas-mouth-removal';
import { cropTo16x9AndUpload } from '../image-gen-dispatch';
import { upscaleViaRecraft } from '../upscale';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '../r2';
import { augmentCellPrompt, COLLAGE_CELL_PROMPT_CAP, SINGLE_SHOT_PROMPT_CAP } from '../prompt-augmentation';
import { SAFE_FRAMING_EDIT_SUFFIX } from '../prompt-framing';
import { computeImageCanvas } from '../render-canvas';
import { logger } from '../logger';
import { recordIntent, markDelivered, markFailed } from '../provider-generations';

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
}

/** Doc-level fields the helper needs to dispatch correctly. */
export interface PipelineImageDoc {
  rows: PipelineImageRow[];
  style_preset?: string;
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
  const refs = style
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

  const i2iModel = style.preferred_cloud_model ?? DEFAULT_CLOUD_I2I_MODEL;
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
  const trimmedInstruction = editInstruction.replace(/\.\s*$/, '');
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
}): Promise<PipelineCollageGroupResult> {
  const t0 = Date.now();
  const { cells, characterDescriptions, workspaceId = null, ownerId = null } = args;

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
      providerModel: `openai/gpt-image-2/t2i#attempt-${attempt}`,
    });
    let attemptProviderRequestId: string | null = null;
    try {
      logger.info('[pipeline image-gen collage] start', {
        attempt,
        prompt_chars: composedPrompt.length,
      });
      // 1536x1024 → cropTo16x9AndUpload → Recraft 4× upscale → ~6144×3456.
      const atlasResult = await generateAtlasT2I({
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
  if (styleHasRefs) {
    return { eligible: false, reason: 'style_refs' };
  }
  return { eligible: true };
}

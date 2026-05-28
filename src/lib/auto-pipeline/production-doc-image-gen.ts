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
import { generateAtlasEdit } from './../atlas-cloud-images';
import { generateMouthRemovedBase } from '../atlas-mouth-removal';
import { cropTo16x9AndUpload } from '../image-gen-dispatch';
import { upscaleViaRecraft } from '../upscale';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '../r2';
import { augmentCellPrompt, SINGLE_SHOT_PROMPT_CAP } from '../prompt-augmentation';
import { computeImageCanvas } from '../render-canvas';
import { logger } from '../logger';

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
  // ─── paint_explainer_v1 (2026-05-28) ──────────────────────────────
  // Inline subset of the full MotionBeat / character fields defined on
  // ProductionRow in src/remotion/utils.ts. Re-stated here (not imported)
  // because remotion/utils.ts pulls React-only deps unsafe for this
  // server-only module. The shape must stay in sync with the upstream
  // type — pipeline runs would silently miss new beat kinds otherwise.
  character_id?: string;
  motion_beats?: Array<{ kind: string }>;
  mouth_removed_url?: string;
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
    if (err instanceof ReferenceRejectedError) {
      return {
        error: `reference_rejected:${err.reason}`,
        durationMs: Date.now() - t0,
        costUsd: 0,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[pipeline image-gen base] failed', { detail: msg.slice(0, 200) });
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
}): Promise<PipelineImageResult> {
  const t0 = Date.now();
  const { row, doc } = args;
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
  let sourceRow: PipelineImageRow | undefined;
  if (row.variant_derives_from_previous && variantIdx > 1) {
    sourceRow = doc.rows.find(
      (r) => r.group_id === groupId && (r.variant_index ?? 0) === variantIdx - 1,
    );
  }
  if (!sourceRow) {
    sourceRow = doc.rows.find(
      (r) => r.group_id === groupId && (r.variant_index ?? 0) === 0,
    );
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
  const composedPrompt = `${trimmedInstruction}. Keep everything else in the image identical to the input.`;

  try {
    const atlasResult = await generateAtlasEdit({
      prompt: composedPrompt,
      images: [sourceImageUrl],
      size: '1536x1024',
      quality: 'low',
    });
    // Atlas Edit returns 3:2 (1536×1024). Center-crop to 16:9 (1536×864)
    // before upscale so the rendered variant lands in the 16:9 canvas
    // without the BRollScene's object-fit:cover slicing 7.8% off the top
    // and bottom at render time. The collage route and the manual t2i
    // dispatcher both do this; this path used to skip it (verified
    // 2026-05-27 against the cropping issue user-reported on project
    // 7fafe333). Same R2 prefix as the dispatcher so all Atlas-crop
    // intermediates land in one place.
    const croppedUrl = await cropTo16x9AndUpload(atlasResult.url, 'prodoc-images-atlas-crop');
    const upscale = await upscaleViaRecraft(croppedUrl);
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
    logger.info('[pipeline image-gen variant] succeeded', {
      group_id: groupId,
      variant_index: variantIdx,
      predict_ms: atlasResult.predictTimeMs,
      cost_usd: 0.011,
    });
    return {
      imageUrl,
      durationMs: Date.now() - t0,
      modelUsed: 'openai/gpt-image-2/edit',
      costUsd: 0.011,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[pipeline image-gen variant] failed', { detail: msg.slice(0, 200) });
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
}): Promise<PipelineImageResult> {
  const t0 = Date.now();
  const { baseImageUrl, characterId } = args;
  if (!baseImageUrl.trim()) {
    return { error: 'empty_base_image_url', durationMs: Date.now() - t0, costUsd: 0 };
  }
  if (!characterId.trim()) {
    return { error: 'empty_character_id', durationMs: Date.now() - t0, costUsd: 0 };
  }

  try {
    const removal = await generateMouthRemovedBase(baseImageUrl);
    // Same crop+upscale+mirror chain as `generateVariantImage`. The
    // mouth-removed PNG must end up at the same 16:9 aspect and post-
    // upscale resolution as the row's `image_url` base so the Remotion
    // `<MouthSwap>` overlay lines up with the underlying face.
    const croppedUrl = await cropTo16x9AndUpload(removal.url, 'prodoc-images-atlas-crop');
    const upscale = await upscaleViaRecraft(croppedUrl);
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
      predict_ms: removal.predictTimeMs,
      cost_usd: 0.011,
    });
    return {
      imageUrl: mouthRemovedUrl,
      durationMs: Date.now() - t0,
      modelUsed: 'openai/gpt-image-2/edit',
      costUsd: 0.011,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[pipeline image-gen mouth-removed] failed', {
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
}): Promise<PipelineImageResult> {
  const t0 = Date.now();
  const { baseImageUrl, characterId, newScenePrompt } = args;
  if (!baseImageUrl.trim()) {
    return { error: 'empty_base_image_url', durationMs: Date.now() - t0, costUsd: 0 };
  }
  if (!characterId.trim()) {
    return { error: 'empty_character_id', durationMs: Date.now() - t0, costUsd: 0 };
  }
  if (!newScenePrompt.trim()) {
    return { error: 'empty_scene_prompt', durationMs: Date.now() - t0, costUsd: 0 };
  }

  const editPrompt = buildCharacterContinuationEditPrompt(newScenePrompt);
  try {
    const edit = await generateAtlasEdit({
      prompt: editPrompt,
      images: [baseImageUrl],
      size: '2560x1440',
      quality: 'low',
    });
    // Same crop+upscale+R2-mirror chain as the variant edit path. Atlas
    // returns 2560x1440 here so the 16:9 crop is a no-op, but routing
    // through the helper keeps the post-gen pipeline uniform.
    const croppedUrl = await cropTo16x9AndUpload(edit.url, 'prodoc-images-atlas-crop');
    const upscale = await upscaleViaRecraft(croppedUrl);
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
    logger.info('[pipeline image-gen character-continuation] succeeded', {
      character_id: characterId,
      predict_ms: edit.predictTimeMs,
      cost_usd: 0.011,
    });
    return {
      imageUrl: finalUrl,
      durationMs: Date.now() - t0,
      modelUsed: 'openai/gpt-image-2/edit',
      costUsd: 0.011,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[pipeline image-gen character-continuation] failed', {
      character_id: characterId,
      detail: msg.slice(0, 200),
    });
    return { error: msg.slice(0, 200), durationMs: Date.now() - t0, costUsd: 0 };
  }
}

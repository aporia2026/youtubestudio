/**
 * Stage handler: generate every production-doc row's image
 * server-side, so end-to-end pipeline videos arrive at the editor
 * with images already populated.
 *
 * Active for stage `generating_production_doc_images`. Loads the
 * latest production_doc artefact, walks rows, generates images for
 * any row that has a non-empty `ai_image_prompt` and no `image_url`
 * yet. Chunks work across ticks: processes up to ROWS_PER_TICK rows
 * per invocation, persists progress on each tick by overwriting the
 * artefact's `metadata_jsonb.doc.rows[i].image_url`. When more rows
 * remain, advances to the SAME stage (cron re-claims on the next
 * tick). When all rows are done, advances to `generating_thumbnail`.
 *
 * Hard cost cap (PIPELINE_IMAGE_GEN_CAP_USD env, default $10/job)
 * aborts mid-stage if the cumulative estimated cost exceeds the
 * ceiling. Cap counts only what THIS stage spends; doc-gen and
 * thumbnail costs are tracked separately.
 *
 * Idempotency: every row check is `if (row.image_url) skip`, so the
 * stage is safe to re-run after any failure or partial completion.
 * The artefact's metadata_jsonb is updated atomically per chunk via
 * `UPDATE … SET metadata_jsonb = $1` so a Vercel timeout mid-chunk
 * at worst loses one row's progress, not the whole batch.
 *
 * Generation order:
 *   1. Bases first (variant_index === 0 or no variant_index).
 *   2. Variants second, BUT only when their source (base or previous
 *      variant) has an image_url. A variant whose source isn't ready
 *      this tick gets skipped and re-considered next tick.
 *
 * v1 limitations (documented as follow-up work):
 *   - No empirical Atlas concurrency cap — runs sequentially within
 *     a tick to stay well under any rate limit. Parallelisation
 *     comes after a concurrency probe.
 *   - No cron-sweeper integration beyond what `claimNextVideo` does
 *     by default (claim TTL releases a stale claim back to the
 *     queue).
 *
 * See `_plans/2026-05-27-doodle-explainer-2-foundation.md` (Stage 4).
 */
import { sql } from '@vercel/postgres';
import { logger } from '../../logger';
import type { StageHandlerContext, StageOutcome } from '../types';
import {
  generateBaseImage,
  generateCharacterContinuationImage,
  generateCollageGroup,
  generateMouthRemovedForCharacter,
  generateSceneContinuationImage,
  generateVariantImage,
  isCollageEligibleRow,
  type PipelineCollageCellInput,
  type PipelineImageDoc,
  type PipelineImageRow,
} from '../production-doc-image-gen';
import { extractCharacterAnchors } from '../../anchor-vision-pass';
import { resolveStyle } from '../../production-doc-styles';
import { loadStyleReferences } from '../../production-doc-styles-refs';

/** Max rows to attempt per tick. Sized so the worst-case Atlas i2i
 *  latency (~30 s) × 8 rows = ~240 s stays under the Vercel 300 s
 *  function timeout with headroom for the per-tick DB read/write.
 *
 *  paint_explainer_v1 docs use a smaller budget because each character
 *  base may chain into an extra ~40 s Atlas Edit call for the mouth-
 *  removed variant. 4 × 30 s base + 4 × 40 s mouth-removed = 280 s, under
 *  the 300 s timeout with the same headroom margin. */
const ROWS_PER_TICK_DEFAULT = 8;
const ROWS_PER_TICK_PAINT_EXPLAINER_V1 = 4;

/** Hard cap on how many fresh Atlas mouth-removal calls a single tick
 *  can run. Most paint_explainer_v1 ticks generate at most 1–2 new
 *  characters (recurring mascot + occasional guest); 3 leaves headroom
 *  for an unusual cast-introduction tick. After this cap, character
 *  base rows that need a mouth-removed still get their base persisted
 *  — they're picked up next tick because their `mouth_removed_url`
 *  is still empty. */
const MAX_MOUTH_REMOVED_PER_TICK = 3;

/** Hard cap on how many vision-pass Kie calls a single tick can run.
 *  Each call is ~10–15s; capping at 3 keeps the worst-case tick budget
 *  (4 × 30s base + 3 × 40s mouth-removed + 3 × 15s vision = 285s)
 *  under Vercel's 300s timeout. Deferred entries come back next tick
 *  via the same retry pattern as mouth-removed (cache entry without
 *  `anchors` triggers another attempt). */
const MAX_VISION_PASS_PER_TICK = 3;

/** Conservative cost per vision-pass call (kie-gemini-3.1-pro). The
 *  exact number depends on Kie's per-token rate at call time;
 *  $0.005 over-estimates a typical call (~$0.001–0.003) which keeps
 *  the cap pre-check safely conservative. */
const COST_PER_VISION_PASS = 0.005;

/** Per-job hard cost cap. Read from env so Vercel can override
 *  without a redeploy. Defaults to $10 — generous for typical 30-row
 *  docs (~$1) but bounds the blast radius if a misconfigured doc has
 *  hundreds of rows. */
function readCostCap(): number {
  const raw = process.env.PIPELINE_IMAGE_GEN_CAP_USD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export async function handleGenerateProductionDocImages(
  ctx: StageHandlerContext,
): Promise<StageOutcome> {
  const { video } = ctx;

  // 1) Load the latest production_doc artefact. The handler runs
  //    AFTER generate-production-doc, so this row should exist; if
  //    not, that's an invariant violation (orchestrator routed us
  //    here without the prior stage completing).
  //
  //    Cross-workspace guard: JOIN through pipeline_run_videos so the
  //    artefact only resolves when its parent video belongs to this
  //    handler's workspace. Without the join a malformed
  //    pipeline_run_video_id pointed at another workspace would
  //    return that workspace's artefact unchallenged. The orchestrator
  //    only routes here through a properly-scoped claim, but defense
  //    in depth — never trust the input row's id alone (rule 13).
  const { rows: artefactRows } = await sql.query<{
    id: string;
    metadata_jsonb: Record<string, unknown> | null;
  }>(
    `
    SELECT psa.id::text AS id, psa.metadata_jsonb
      FROM pipeline_stage_artefacts psa
      JOIN pipeline_run_videos prv ON prv.id = psa.pipeline_run_video_id
     WHERE psa.pipeline_run_video_id = $1::uuid
       AND prv.workspace_id = $2::uuid
       AND psa.stage = 'generating_production_doc'
       AND psa.artefact_kind = 'production_doc'
     ORDER BY psa.attempt_number DESC
     LIMIT 1
    `,
    [video.id, video.workspace_id],
  );
  if (artefactRows.length === 0 || !artefactRows[0].metadata_jsonb) {
    return {
      kind: 'fail',
      terminalStage: 'production_doc_images_failed',
      failureClass: 'invariant_violation',
      failureMessage: 'No production-doc artefact found; image-gen stage reached without prior stage completing.',
    };
  }
  const artefactId = artefactRows[0].id;
  const metadata = artefactRows[0].metadata_jsonb as Record<string, unknown>;
  const doc = metadata.doc as PipelineImageDoc | undefined;
  if (!doc || !Array.isArray(doc.rows)) {
    return {
      kind: 'fail',
      terminalStage: 'production_doc_images_failed',
      failureClass: 'invariant_violation',
      failureMessage: 'Production-doc artefact has no rows array; doc structure malformed.',
    };
  }

  // 2) Partition rows by what needs work. Bases first so variants
  //    have something to chain from. Skips rows that already have an
  //    image_url (idempotent re-entry) or no ai_image_prompt
  //    (title cards, talking heads — never need AI generation).
  const baseIndicesToGen: number[] = [];
  const variantIndicesToGen: number[] = [];
  doc.rows.forEach((row, i) => {
    if (row.image_url?.trim()) return;
    const prompt = (row.ai_image_prompt ?? '').trim();
    const variantIdx = row.variant_index ?? 0;
    if (variantIdx === 0) {
      // Base / standalone — needs a non-empty prompt to even attempt.
      if (!prompt) return;
      baseIndicesToGen.push(i);
    } else {
      // Variant — needs a non-empty variant_edit_prompt. Source
      // readiness is checked just-in-time inside the loop below
      // (the source might be generated earlier in this same tick).
      if (!row.variant_edit_prompt?.trim()) return;
      variantIndicesToGen.push(i);
    }
  });

  // 3) Nothing to do — advance straight to the next stage.
  if (baseIndicesToGen.length === 0 && variantIndicesToGen.length === 0) {
    logger.info('auto-pipeline: production-doc-images all done', {
      pipeline_video_id: video.id,
      total_rows: doc.rows.length,
    });
    return { kind: 'advance', nextStage: 'generating_thumbnail', costUsd: 0 };
  }

  // 4) Cost cap pre-check — refuse to start if the FULL remaining
  //    work (across all future ticks) would blow the ceiling. The
  //    cap counts only spend this STAGE has accrued; we estimate
  //    using the same conservative numbers the manual UI surfaces
  //    ($0.04 / base, $0.011 / variant edit). For paint_explainer_v1,
  //    base rows that are character shots also incur ~$0.011 for the
  //    mouth-removed companion call; we add a $0.01 buffer per base
  //    rather than parse motion_beats here — conservative for the cap.
  const isPaintExplainerV1 = doc.style_preset === 'paint_explainer_v1';
  const isDoodleExplainer2 = doc.style_preset === 'doodle_explainer_2';
  const COST_PER_BASE = isPaintExplainerV1 ? 0.05 : 0.04;
  const COST_PER_VARIANT = 0.011;
  const remainingCostUsd =
    baseIndicesToGen.length * COST_PER_BASE +
    variantIndicesToGen.length * COST_PER_VARIANT;
  const alreadySpentUsd = parsePriorStageSpend(metadata);
  const capUsd = readCostCap();
  if (alreadySpentUsd + remainingCostUsd > capUsd) {
    logger.warn('auto-pipeline: production-doc-images cost cap would be exceeded', {
      pipeline_video_id: video.id,
      already_spent_usd: alreadySpentUsd,
      remaining_cost_usd: remainingCostUsd,
      cap_usd: capUsd,
    });
    return {
      kind: 'fail',
      terminalStage: 'cost_cap_exceeded',
      failureClass: 'cost_cap_exceeded',
      failureMessage: `Image generation would exceed the per-job cap of $${capUsd.toFixed(2)} ($${alreadySpentUsd.toFixed(2)} already spent + $${remainingCostUsd.toFixed(2)} remaining).`,
    };
  }

  // 4.5) Build collage chunks from consecutive eligible bases.
  //
  //   Plan: _plans/2026-05-28-auto-pipeline-collage-port.md.
  //
  //   Each chunk consumes 4 bases but the per-tick BUDGET reserves 8
  //   credits because on the malformed-after-retry fallback path the
  //   helper hands the 4 rows back as single-shot retries (4 more Atlas
  //   calls in the same tick). Worst-case: 1 collage call (~60s) + 1
  //   retry (~60s) + 4 single-shot fallbacks (~120s) = ~240s, under
  //   the 300s Vercel ceiling but only if NO other work runs after.
  //   So a tick that schedules even one collage chunk packs no
  //   additional bases / variants. The single-shot loop budget below
  //   subtracts 8 credits per chunk to enforce this.
  //
  //   Eligibility is per-row: see isCollageEligibleRow. The chunker
  //   only groups CONSECUTIVE eligible bases — a single ineligible
  //   row breaks the run, and the remaining eligible rows fall through
  //   to single-shot. Trying to cherry-pick non-consecutive eligible
  //   rows into a chunk would shuffle the doc's natural fill order,
  //   confusing the user watching rows populate top-to-bottom.
  const collageOn = doc.collage_mode !== false;
  // Load style refs ONCE for the whole tick — every row in the same
  // doc has the same style. If refs are present, every base row is
  // ineligible for collage (route is t2i-only). For paint_explainer_v1
  // we also skip collage entirely — the motion-beat / mouth-removed
  // chain depends on a single coherent base frame per character, which
  // a sliced collage quadrant can't reliably provide.
  let styleHasRefs = false;
  if (collageOn && !isPaintExplainerV1) {
    const styleId = doc.style_preset?.trim();
    if (styleId) {
      const style = await resolveStyle(styleId, video.workspace_id, null);
      if (style) {
        const refs = await loadStyleReferences(style.id, {
          excludeRejected: true,
          excludeUnvalidated: true,
          workspaceId: video.workspace_id,
        });
        styleHasRefs = refs.length > 0;
      }
    }
  }
  const collageChunks: number[][] = [];
  const collageIneligibleBaseIndices = new Set<number>();
  if (collageOn && !isPaintExplainerV1) {
    // Greedy: walk baseIndicesToGen in DOC ORDER, accumulate eligible
    // rows into a buffer, flush a chunk every time the buffer hits 4 OR
    // an ineligible row breaks the run. The tail buffer (< 4) gets
    // emptied back into the single-shot path.
    let buffer: number[] = [];
    const ineligibleReasons: Record<string, number> = {};
    for (const idx of baseIndicesToGen) {
      const verdict = isCollageEligibleRow(doc.rows[idx], doc, styleHasRefs);
      if (verdict.eligible) {
        buffer.push(idx);
        if (buffer.length === 4) {
          collageChunks.push(buffer);
          buffer = [];
        }
      } else {
        // Flush partial buffer back to single-shot — chunk-of-3 isn't
        // supported by the route's collage template.
        for (const b of buffer) collageIneligibleBaseIndices.add(b);
        buffer = [];
        collageIneligibleBaseIndices.add(idx);
        if (verdict.reason) {
          ineligibleReasons[verdict.reason] = (ineligibleReasons[verdict.reason] ?? 0) + 1;
        }
      }
    }
    // Anything left in the buffer at end-of-loop is tail-of-<4 — also
    // single-shot.
    for (const b of buffer) collageIneligibleBaseIndices.add(b);
    logger.info('[pipeline image-gen collage] eligibility', {
      pipeline_video_id: video.id,
      collage_on: collageOn,
      style_has_refs: styleHasRefs,
      total_bases: baseIndicesToGen.length,
      eligible_chunks: collageChunks.length,
      eligible_rows: collageChunks.length * 4,
      ineligible_reasons: ineligibleReasons,
    });
  } else {
    logger.info('[pipeline image-gen collage] disabled', {
      pipeline_video_id: video.id,
      reason: !collageOn ? 'doc_toggle_off' : 'paint_explainer_v1',
    });
    // Everything goes to single-shot.
    for (const idx of baseIndicesToGen) collageIneligibleBaseIndices.add(idx);
  }

  // 5) Build this tick's plan — bases first up to ROWS_PER_TICK,
  //    then variants whose source is ready (or will be ready
  //    in-tick). Order is stable: base index ascending, then variant
  //    index ascending.
  const rowsPerTick = isPaintExplainerV1
    ? ROWS_PER_TICK_PAINT_EXPLAINER_V1
    : ROWS_PER_TICK_DEFAULT;

  // Reserve 8 row-credits per scheduled collage chunk (4 cells +
  // 4 fallback worst-case). The first chunk alone fills the default
  // 8-credit budget — any subsequent chunk or single-shot work waits
  // for the next tick. This caps the per-tick wall-clock at the
  // ~240s worst case and prevents Vercel timeouts mid-fallback.
  const collageBudgetPerChunk = 8;
  const scheduledCollageChunks: number[][] = [];
  let creditsUsed = 0;
  for (const chunk of collageChunks) {
    if (creditsUsed + collageBudgetPerChunk > rowsPerTick) break;
    scheduledCollageChunks.push(chunk);
    creditsUsed += collageBudgetPerChunk;
  }
  // Any unscheduled chunks defer their indices to next tick — they
  // stay in `baseIndicesToGen` via the `isPlannedThisTick` filter
  // below (which only includes scheduled chunk indices AND
  // collageIneligibleBaseIndices).
  const scheduledCollageIndices = new Set<number>();
  for (const chunk of scheduledCollageChunks) {
    for (const idx of chunk) scheduledCollageIndices.add(idx);
  }

  const plan: Array<{ index: number; kind: 'base' | 'variant' }> = [];
  for (const idx of baseIndicesToGen) {
    if (plan.length + creditsUsed >= rowsPerTick) break;
    // Skip rows already going through collage this tick.
    if (scheduledCollageIndices.has(idx)) continue;
    // Skip rows that fell out of collage as a single-shot — they're
    // queued here but only when they're known to be ineligible
    // (chunks of 4 fully scheduled in scheduledCollageIndices are the
    // ONLY indices that should bypass this loop).
    if (!collageIneligibleBaseIndices.has(idx) && collageOn && !isPaintExplainerV1) {
      // Row is in an UNSCHEDULED collage chunk — defer to next tick.
      continue;
    }
    plan.push({ index: idx, kind: 'base' });
  }
  // Track which row indices will have image_url by the time variants
  // run (in-tick). The variant readiness check is conservative — only
  // queues a variant when its source is already in the doc; variants
  // whose source is in THIS tick's base plan get deferred to the
  // next tick (avoids reading-while-writing the same doc structure).
  // Includes scheduled collage indices because those rows are ALSO
  // produced in this tick — a variant referencing a collage-bound base
  // must wait for next tick to see the populated image_url.
  const inFlightBaseIndices = new Set([
    ...plan.map((p) => p.index),
    ...scheduledCollageIndices,
  ]);
  for (const idx of variantIndicesToGen) {
    // Honor the collage chunk reservation: a scheduled chunk pre-paid
    // 8 credits for itself (4 cells + 4 fallback worst-case). Variants
    // count 1 credit each against `plan.length`. Without `creditsUsed`
    // here the variant loop would happily admit 8 variants on top of
    // a scheduled chunk, blowing the 300s Vercel ceiling on the worst-
    // case fallback path (~1 collage + 1 retry + 4 single-shot
    // fallbacks + 8 variants > 360s). Caught in 2026-05-28 code review.
    if (plan.length + creditsUsed >= rowsPerTick) break;
    const variant = doc.rows[idx];
    const sourceIdx = resolveSourceRowIndex(variant, doc);
    if (sourceIdx === -1) continue;
    const sourceRow = doc.rows[sourceIdx];
    const sourceHasImageNow = Boolean(sourceRow.image_url?.trim());
    if (!sourceHasImageNow) continue; // wait for next tick
    if (inFlightBaseIndices.has(sourceIdx)) continue; // wait for next tick
    plan.push({ index: idx, kind: 'variant' });
  }

  // 6) Generate. Sequential within the tick — Atlas concurrency
  //    behavior on multi-image edit calls isn't empirically pinned
  //    yet, so we err on the side of not hammering the provider.
  //    Per-row failures don't abort the tick — they leave image_url
  //    unset so the next tick (or the user manually) can retry.
  let succeeded = 0;
  let failed = 0;
  let tickCostUsd = 0;
  // Collage counters — surfaced in the per-tick summary log so cost
  // attribution between collage and single-shot is visible in one line.
  let collageChunksSucceeded = 0;
  let collageChunksFallback = 0;
  let collageCellsSucceeded = 0;
  let collageCellsFromFallback = 0;
  let mouthRemovedThisTick = 0;
  let mouthRemovedSucceeded = 0;
  let mouthRemovedSkipped = 0;
  let mouthRemovedFailed = 0;
  let visionPassThisTick = 0;
  let visionPassSucceeded = 0;
  let visionPassSkipped = 0;
  let visionPassFailed = 0;
  // doodle_explainer_2 character cache counters — surfaced in the
  // per-tick summary log so a single Vercel log line shows how much
  // character-continuation reuse happened this tick.
  let charCacheHits = 0;
  let charCacheMisses = 0;
  let charCacheEditFailures = 0;
  // Phase 3 — scene-cache counters. Same shape as the character-cache
  // counters; surfaced in the per-tick summary log so a single Vercel
  // line shows how much location reuse happened this tick.
  let sceneCacheHits = 0;
  let sceneCacheMisses = 0;
  let sceneCacheEditFailures = 0;

  // ─── Collage chunks first ──────────────────────────────────────────
  // Run scheduled collage chunks before the per-row plan. Each chunk:
  //   - Builds 4 cell inputs from the row metadata.
  //   - Calls generateCollageGroup (Atlas T2I + Recraft + slice).
  //   - On success: writes 4 image_urls and adds 4 to `succeeded`.
  //   - On fallbackNeeded: pushes the 4 indices into `plan` as
  //     single-shot bases so the loop below regenerates them
  //     individually. This is the worst case the 8-credit-per-chunk
  //     budget accommodates.
  // Plan: _plans/2026-05-28-auto-pipeline-collage-port.md.
  for (const chunk of scheduledCollageChunks) {
    const cells = chunk.map((idx): PipelineCollageCellInput => {
      const r = doc.rows[idx];
      return {
        prompt: r.ai_image_prompt ?? '',
        onScreenText: r.on_screen_text,
        onScreenTextMode: r.on_screen_text_mode ?? doc.on_screen_text_mode_default,
        sectionTitle: r.section_title,
        sectionTitleLayout: r.section_title_layout ?? doc.section_title_layout_default,
      };
    }) as [PipelineCollageCellInput, PipelineCollageCellInput, PipelineCollageCellInput, PipelineCollageCellInput];
    const groupResult = await generateCollageGroup({
      cells,
      characterDescriptions: doc.doodle_explainer_2_character_descriptions,
    });
    tickCostUsd += groupResult.totalCostUsd;
    if (!groupResult.fallbackNeeded) {
      collageChunksSucceeded += 1;
      for (let i = 0; i < chunk.length; i++) {
        const rowIdx = chunk[i];
        const cellResult = groupResult.results[i];
        if (cellResult.imageUrl) {
          doc.rows[rowIdx].image_url = cellResult.imageUrl;
          collageCellsSucceeded += 1;
          succeeded += 1;
        } else {
          // Defensive — generateCollageGroup should return either all-
          // valid or fallbackNeeded. A per-cell error here means slice
          // succeeded but a quadrant somehow didn't get a URL. Treat
          // the row as a fallback case (push to plan for single-shot
          // retry within the remaining tick budget — best-effort).
          collageCellsFromFallback += 1;
          plan.push({ index: rowIdx, kind: 'base' });
        }
      }
      logger.info('[pipeline image-gen collage] chunk done', {
        pipeline_video_id: video.id,
        chunk_row_indices: chunk,
        cost_usd: groupResult.totalCostUsd,
        duration_ms: groupResult.durationMs,
      });
    } else {
      collageChunksFallback += 1;
      logger.warn('[pipeline image-gen collage] chunk fell back to single-shot', {
        pipeline_video_id: video.id,
        chunk_row_indices: chunk,
        reason: groupResult.reason,
      });
      // Push all 4 rows into the single-shot plan for this tick. The
      // budget reservation (8 credits per chunk) makes room for this.
      for (const idx of chunk) {
        plan.push({ index: idx, kind: 'base' });
        collageCellsFromFallback += 1;
      }
    }
  }

  for (const item of plan) {
    const row = doc.rows[item.index];

    // doodle_explainer_2 character continuation — runs BEFORE the
    // normal base/variant generation path. When this row has a
    // `character_id` that's already in the per-doc cache, skip the
    // expensive i2i call and instead call Atlas Edit on the cached
    // base with this row's ai_image_prompt as the edit instruction.
    // Atlas Edit preserves the character's face/hair/clothing while
    // changing pose/setting — see generateCharacterContinuationImage.
    // Cache miss with character_id set: the row goes through normal
    // generation, and the result is written into the cache AFTER
    // success so subsequent rows can reuse it.
    // Plan: _plans/2026-05-28-doodle-2-character-cache.md.
    let result;
    const useCharCache =
      isDoodleExplainer2
      && item.kind === 'base'
      && typeof row.character_id === 'string'
      && row.character_id.trim().length > 0;
    const charCache = doc.doodle_explainer_2_character_cache ?? {};
    const cachedChar = useCharCache ? charCache[row.character_id as string] : undefined;
    if (
      useCharCache
      && cachedChar?.base_url
      && typeof row.ai_image_prompt === 'string'
      && row.ai_image_prompt.trim().length > 0
    ) {
      const editResult = await generateCharacterContinuationImage({
        baseImageUrl: cachedChar.base_url,
        characterId: row.character_id as string,
        newScenePrompt: row.ai_image_prompt,
        characterDescriptions: doc.doodle_explainer_2_character_descriptions,
      });
      if (editResult.imageUrl) {
        charCacheHits += 1;
        logger.info('[doodle-2 character-cache] hit-and-edit', {
          pipeline_video_id: video.id,
          row_index: item.index,
          character_id: row.character_id,
          first_seen_row_index: cachedChar.first_seen_row_index,
          cost_usd: editResult.costUsd,
          duration_ms: editResult.durationMs,
        });
        result = editResult;
      } else {
        // Edit failed (network, model error, etc.). Fall back to fresh
        // i2i below — better to ship a drifted character image than
        // fail the row entirely. The cache stays populated so the
        // next row with this character_id will try Edit again.
        charCacheEditFailures += 1;
        logger.warn('[doodle-2 character-cache] hit but edit failed, falling back to i2i', {
          pipeline_video_id: video.id,
          row_index: item.index,
          character_id: row.character_id,
          error: editResult.error,
        });
      }
    }

    // Phase 3 — scene cache. Only runs when the character cache didn't
    // already produce a result (precedence rule: character wins). Same
    // shape as the character branch but anchors the location instead.
    // Spec: _plans/2026-05-28-doodle-2-scene-cache.md.
    const useSceneCache =
      !result
      && isDoodleExplainer2
      && item.kind === 'base'
      && typeof row.scene_id === 'string'
      && row.scene_id.trim().length > 0;
    const sceneCache = doc.doodle_explainer_2_scene_cache ?? {};
    const cachedScene = useSceneCache ? sceneCache[row.scene_id as string] : undefined;
    if (
      useSceneCache
      && cachedScene?.base_url
      && typeof row.ai_image_prompt === 'string'
      && row.ai_image_prompt.trim().length > 0
    ) {
      const editResult = await generateSceneContinuationImage({
        baseImageUrl: cachedScene.base_url,
        sceneId: row.scene_id as string,
        newScenePrompt: row.ai_image_prompt,
        characterDescriptions: doc.doodle_explainer_2_character_descriptions,
      });
      if (editResult.imageUrl) {
        sceneCacheHits += 1;
        logger.info('[doodle-2 scene-cache] hit-and-edit', {
          pipeline_video_id: video.id,
          row_index: item.index,
          scene_id: row.scene_id,
          first_seen_row_index: cachedScene.first_seen_row_index,
          cost_usd: editResult.costUsd,
          duration_ms: editResult.durationMs,
        });
        result = editResult;
      } else {
        sceneCacheEditFailures += 1;
        logger.warn('[doodle-2 scene-cache] hit but edit failed, falling back to i2i', {
          pipeline_video_id: video.id,
          row_index: item.index,
          scene_id: row.scene_id,
          error: editResult.error,
        });
      }
    }

    // Normal generation path — runs when we didn't hit the cache (or
    // hit it but the Edit call failed and we're falling back).
    if (!result) {
      result =
        item.kind === 'base'
          ? await generateBaseImage({
              row,
              doc,
              workspaceId: video.workspace_id,
            })
          : await generateVariantImage({ row, doc });
    }
    tickCostUsd += result.costUsd;
    if (result.imageUrl) {
      // Mutate the in-memory doc so subsequent variants in this same
      // tick see the new image_url when checking their source.
      doc.rows[item.index].image_url = result.imageUrl;
      succeeded += 1;

      // ─── doodle_explainer_2 character cache write-back ──────────
      // Cache miss case: this row had a character_id but no cached
      // base existed. Now that the fresh i2i generation succeeded,
      // store the result so the NEXT row with the same character_id
      // can skip generation and use Atlas Edit on this base instead.
      // Skip if `cachedChar` was set (we either hit + reused above,
      // or hit + edit-failed and fell back — either way the cache
      // entry already exists and we don't want to overwrite the
      // canonical character image with a fallback drift).
      if (
        useCharCache
        && !cachedChar
        && typeof row.character_id === 'string'
        && row.character_id.length > 0
      ) {
        charCache[row.character_id] = {
          base_url: result.imageUrl,
          first_seen_row_index: item.index,
        };
        doc.doodle_explainer_2_character_cache = charCache;
        charCacheMisses += 1;
        logger.info('[doodle-2 character-cache] miss-and-store', {
          pipeline_video_id: video.id,
          row_index: item.index,
          character_id: row.character_id,
        });
      }

      // ─── Phase 3 — doodle_explainer_2 scene cache write-back ──────
      // Cache miss case for the scene anchor. Independent of the
      // character cache write above: a single i2i result populates
      // BOTH caches when the row has both anchors (character_id +
      // scene_id) and neither is yet cached. Subsequent rows with
      // either anchor hit their respective cache; the precedence
      // rule (character wins) applies only at READ time.
      //
      // The miss-and-store fires even when the character cache also
      // wrote on this row — the same i2i base is reused as the
      // canonical anchor for BOTH the character and the scene.
      if (
        isDoodleExplainer2
        && item.kind === 'base'
        && typeof row.scene_id === 'string'
        && row.scene_id.length > 0
        && !cachedScene
      ) {
        sceneCache[row.scene_id] = {
          base_url: result.imageUrl,
          first_seen_row_index: item.index,
        };
        doc.doodle_explainer_2_scene_cache = sceneCache;
        sceneCacheMisses += 1;
        logger.info('[doodle-2 scene-cache] miss-and-store', {
          pipeline_video_id: video.id,
          row_index: item.index,
          scene_id: row.scene_id,
        });
      }

      // ─── paint_explainer_v1 mouth-removed chain ──────────────────
      // Runs only on base rows in a paint_explainer_v1 doc whose row
      // carries a `character_id` AND emits a `mouth_swap` motion beat.
      // Per-tick capped at MAX_MOUTH_REMOVED_PER_TICK so the Vercel
      // 300 s budget stays intact even when this tick happens to
      // contain several never-before-seen characters. Rows that hit
      // the cap have their base persisted but no `mouth_removed_url`
      // — they're picked up next tick (image_url present + motion
      // beats present but no mouth_removed_url = unfinished work).
      if (
        item.kind === 'base'
        && isPaintExplainerV1
        && needsMouthRemoved(row)
        && row.character_id
      ) {
        const cache = doc.paint_explainer_v1_character_cache ?? {};
        const characterId = row.character_id;
        const cached = cache[characterId];
        if (cached?.mouth_removed_url) {
          // Cache hit — character already generated earlier in this
          // doc (possibly even earlier in this same tick). Reuse the
          // URL; no Atlas call, no cost.
          doc.rows[item.index].mouth_removed_url = cached.mouth_removed_url;
          mouthRemovedSucceeded += 1;
          logger.info('[paint-explainer-v1 atlas-mouth-removed] cache hit', {
            pipeline_video_id: video.id,
            row_index: item.index,
            character_id: characterId,
          });
        } else if (mouthRemovedThisTick >= MAX_MOUTH_REMOVED_PER_TICK) {
          // Per-tick cap reached. The base is persisted; the next
          // tick will re-enter the stage (mouth_removed_url still
          // unset) and pick this row up. Logged so the cron tail
          // shows why a row was deferred.
          mouthRemovedSkipped += 1;
          logger.info('[paint-explainer-v1 atlas-mouth-removed] deferred to next tick', {
            pipeline_video_id: video.id,
            row_index: item.index,
            character_id: characterId,
            cap: MAX_MOUTH_REMOVED_PER_TICK,
          });
        } else {
          const mrResult = await generateMouthRemovedForCharacter({
            baseImageUrl: result.imageUrl,
            characterId,
          });
          tickCostUsd += mrResult.costUsd;
          mouthRemovedThisTick += 1;
          if (mrResult.imageUrl) {
            doc.rows[item.index].mouth_removed_url = mrResult.imageUrl;
            cache[characterId] = {
              base_url: result.imageUrl,
              mouth_removed_url: mrResult.imageUrl,
              anchors: cached?.anchors,
            };
            doc.paint_explainer_v1_character_cache = cache;
            mouthRemovedSucceeded += 1;
            logger.info('[paint-explainer-v1 atlas-mouth-removed] generated', {
              pipeline_video_id: video.id,
              row_index: item.index,
              character_id: characterId,
              duration_ms: mrResult.durationMs,
              cost_usd: mrResult.costUsd,
            });
          } else {
            mouthRemovedFailed += 1;
            logger.warn('[paint-explainer-v1 atlas-mouth-removed] failed', {
              pipeline_video_id: video.id,
              row_index: item.index,
              character_id: characterId,
              error: mrResult.error,
            });
          }
        }

        // ─── paint_explainer_v1 vision-pass anchor extraction ─────
        // Fires when:
        //   (a) The character's cache entry exists AND lacks anchors
        //       (either fresh from the mouth-removed branch above, OR
        //       a prior tick generated the bases but bailed on
        //       vision-pass — retry path).
        //   (b) We have a base URL to send (cache.base_url OR the
        //       just-generated row.image_url).
        //   (c) Per-tick cap MAX_VISION_PASS_PER_TICK hasn't been hit.
        //
        // Anchors are stored under the cache's `anchors` field keyed
        // by anchor kind ('auto-mouth' / 'auto-eyes' / 'auto-center')
        // so the renderer (PR 1 thread-through next) can look up
        // exactly the kind a motion beat requests.
        //
        // Failure mode: vision-pass returns null → no anchors written
        // → renderer falls back to MouthSwap's hardcoded centered-
        // close-up default. Same gentle-degradation pattern the rest
        // of the pipeline uses.
        const currentCacheEntry = doc.paint_explainer_v1_character_cache?.[row.character_id ?? ''];
        const needsVisionPass =
          item.kind === 'base'
          && isPaintExplainerV1
          && needsMouthRemoved(row)
          && row.character_id
          && currentCacheEntry
          && !currentCacheEntry.anchors;
        if (needsVisionPass) {
          if (visionPassThisTick >= MAX_VISION_PASS_PER_TICK) {
            visionPassSkipped += 1;
            logger.info('[paint-explainer-v1 anchor-vision-pass] deferred to next tick', {
              pipeline_video_id: video.id,
              row_index: item.index,
              character_id: row.character_id,
              cap: MAX_VISION_PASS_PER_TICK,
            });
          } else {
            const visionBaseUrl = currentCacheEntry.base_url || result.imageUrl;
            const anchorResult = await extractCharacterAnchors({ baseImageUrl: visionBaseUrl });
            visionPassThisTick += 1;
            tickCostUsd += COST_PER_VISION_PASS;
            if (anchorResult) {
              const anchors: NonNullable<typeof currentCacheEntry.anchors> = {};
              if (anchorResult.mouthCenter)     anchors['auto-mouth'] = anchorResult.mouthCenter;
              if (anchorResult.eyesCenter)      anchors['auto-eyes'] = anchorResult.eyesCenter;
              if (anchorResult.characterCenter) anchors['auto-center'] = anchorResult.characterCenter;
              const cacheRef = doc.paint_explainer_v1_character_cache ?? {};
              cacheRef[row.character_id!] = {
                ...currentCacheEntry,
                anchors,
              };
              doc.paint_explainer_v1_character_cache = cacheRef;
              visionPassSucceeded += 1;
              logger.info('[paint-explainer-v1 anchor-vision-pass] cached', {
                pipeline_video_id: video.id,
                row_index: item.index,
                character_id: row.character_id,
                model: anchorResult.model,
                has_mouth: Boolean(anchorResult.mouthCenter),
                has_eyes: Boolean(anchorResult.eyesCenter),
                has_center: Boolean(anchorResult.characterCenter),
                cost_usd: COST_PER_VISION_PASS,
              });
            } else {
              // No useful result. Mark as "tried, no useful coords"
              // by writing an empty `anchors` object so the next-tick
              // retry doesn't loop forever. Renderer falls back to
              // MouthSwap's hardcoded centered-close-up default for
              // any anchor kind absent from the (now-empty) map.
              const cacheRef = doc.paint_explainer_v1_character_cache ?? {};
              cacheRef[row.character_id!] = {
                ...currentCacheEntry,
                anchors: {},
              };
              doc.paint_explainer_v1_character_cache = cacheRef;
              visionPassFailed += 1;
              logger.warn('[paint-explainer-v1 anchor-vision-pass] no result — renderer will use defaults', {
                pipeline_video_id: video.id,
                row_index: item.index,
                character_id: row.character_id,
              });
            }
          }
        }
      }
    } else {
      failed += 1;
      logger.warn('auto-pipeline: production-doc-images row failed', {
        pipeline_video_id: video.id,
        row_index: item.index,
        kind: item.kind,
        error: result.error,
        duration_ms: result.durationMs,
      });
    }
  }

  // 7) Persist the updated doc back into the artefact's metadata.
  //    UPDATE in place so we don't generate a new artefact row per
  //    tick (and so getLatestArtefact callers always read the
  //    freshest image_urls).
  const updatedMetadata: Record<string, unknown> = {
    ...metadata,
    doc,
    image_gen_stage_cost_usd: alreadySpentUsd + tickCostUsd,
  };
  await sql.query(
    `
    UPDATE pipeline_stage_artefacts
       SET metadata_jsonb = $1::jsonb
     WHERE id = $2::uuid
    `,
    [JSON.stringify(updatedMetadata), artefactId],
  );

  // 8) Decide: more work remaining → advance to SAME stage (cron
  //    re-claims next tick); all done → advance to thumbnail.
  //    paint_explainer_v1 character rows whose base is generated but
  //    whose mouth-removed companion hasn't been generated yet
  //    ALSO count as remaining — they got deferred by the per-tick
  //    cap and must come back next tick. Same logic for vision-pass:
  //    a character cache entry without `anchors` means the vision
  //    pass either failed or got deferred, and the next tick should
  //    retry.
  const stillRemaining =
    doc.rows.some((r) => {
      if (!r.image_url?.trim()) {
        const prompt = (r.ai_image_prompt ?? '').trim();
        const variantIdx = r.variant_index ?? 0;
        if (variantIdx === 0) return prompt.length > 0;
        return Boolean(r.variant_edit_prompt?.trim());
      }
      if (isPaintExplainerV1 && needsMouthRemoved(r) && r.character_id) {
        // Mouth-removed companion still pending → re-tick.
        if (!r.mouth_removed_url?.trim()) return true;
        // Vision-pass anchors still pending → re-tick. We accept a
        // single empty `anchors: {}` (vision-pass returned no
        // useful coords for this character — typically a back-of-
        // head pose) by requiring the field to be undefined to
        // mean "not yet attempted." Once a vision-pass either
        // populates anchors OR returns null (which currently
        // leaves anchors undefined), the next-tick retry fires
        // exactly once per cache entry before stalling at "no
        // useful anchors."
        const cacheEntry = doc.paint_explainer_v1_character_cache?.[r.character_id];
        if (cacheEntry && cacheEntry.anchors === undefined) return true;
      }
      return false;
    });

  logger.info('auto-pipeline: production-doc-images tick complete', {
    pipeline_video_id: video.id,
    plan_size: plan.length,
    succeeded,
    failed,
    tick_cost_usd: tickCostUsd,
    cumulative_cost_usd: alreadySpentUsd + tickCostUsd,
    still_remaining: stillRemaining,
    // paint_explainer_v1 mouth-removed sub-stage telemetry. All zero
    // on non-paint_explainer_v1 docs.
    mouth_removed_attempted: mouthRemovedThisTick,
    mouth_removed_succeeded: mouthRemovedSucceeded,
    mouth_removed_skipped: mouthRemovedSkipped,
    mouth_removed_failed: mouthRemovedFailed,
    // paint_explainer_v1 vision-pass sub-stage telemetry. All zero
    // on non-paint_explainer_v1 docs.
    vision_pass_attempted: visionPassThisTick,
    vision_pass_succeeded: visionPassSucceeded,
    vision_pass_skipped: visionPassSkipped,
    vision_pass_failed: visionPassFailed,
    // doodle_explainer_2 character-cache telemetry. All zero on
    // non-doodle_explainer_2 docs. A high hit count means the LLM is
    // emitting consistent character_id slugs and the user is getting
    // visual continuity AND cost savings; a high miss count is normal
    // on the first tick of any doc; persistent edit_failures (>0
    // after multiple ticks) means Atlas Edit is unreliable for this
    // style and the fallback path is doing the heavy lifting.
    char_cache_hits: charCacheHits,
    char_cache_misses_stored: charCacheMisses,
    char_cache_edit_failures: charCacheEditFailures,
    // Phase 3 — scene-cache telemetry. Same semantics as the
    // character counters but for the location anchor.
    scene_cache_hits: sceneCacheHits,
    scene_cache_misses_stored: sceneCacheMisses,
    scene_cache_edit_failures: sceneCacheEditFailures,
    // 2026-05-28 collage-port telemetry. All zero when collage is OFF
    // (paint_explainer_v1 docs or `doc.collage_mode === false`).
    //
    //   - collage_chunks_succeeded:  number of 4-up groups that
    //     produced 4 valid quadrants in one Atlas call.
    //   - collage_chunks_fallback:   number of 4-up groups that
    //     reported malformed-after-retry OR threw, and fell back to
    //     4 single-shot calls within this tick's budget.
    //   - collage_cells_succeeded:   number of individual rows whose
    //     image_url came from a collage quadrant (succeeded chunks ×
    //     4 minus any per-cell errors).
    //   - collage_cells_from_fallback: number of individual rows that
    //     were originally collage-bound but got their image_url via
    //     the single-shot loop (fallback path).
    collage_chunks_succeeded: collageChunksSucceeded,
    collage_chunks_fallback: collageChunksFallback,
    collage_cells_succeeded: collageCellsSucceeded,
    collage_cells_from_fallback: collageCellsFromFallback,
  });

  return {
    kind: 'advance',
    nextStage: stillRemaining ? 'generating_production_doc_images' : 'generating_thumbnail',
    costUsd: tickCostUsd,
  };
}

/** True when a paint_explainer_v1 row would benefit from a mouth-
 *  removed companion image: it carries at least one motion beat whose
 *  kind is `mouth_swap`. Other motion-beat kinds (label_pop,
 *  scribble_draw, prop_slide, …) animate over the original base and
 *  don't need the mouth-removed variant.
 *
 *  Defensive: returns false on missing/empty motion_beats so non-
 *  paint_explainer_v1 rows always short-circuit even if some other
 *  code path accidentally calls this helper.
 *
 *  Exported for unit testing — the predicate is small but load-bearing
 *  (it gates the per-row $0.011 Atlas Edit call) so a regression on
 *  it could either silently skip mouth-swap rendering OR run up the
 *  per-video bill. Pure: no IO, safe to call from anywhere. */
export function needsMouthRemoved(row: PipelineImageRow): boolean {
  const beats = row.motion_beats;
  if (!Array.isArray(beats) || beats.length === 0) return false;
  return beats.some((b) => b?.kind === 'mouth_swap');
}

/** Find the row index of a variant's SOURCE — base for parallel
 *  variants, previous variant for chained. Returns -1 when no
 *  valid source exists in the doc. */
function resolveSourceRowIndex(
  variant: PipelineImageRow,
  doc: PipelineImageDoc,
): number {
  const variantIdx = variant.variant_index ?? 0;
  if (variantIdx <= 0) return -1;
  const gid = variant.group_id;
  if (!gid) return -1;
  if (variant.variant_derives_from_previous && variantIdx > 1) {
    const prevIdx = doc.rows.findIndex(
      (r) => r.group_id === gid && (r.variant_index ?? 0) === variantIdx - 1,
    );
    if (prevIdx !== -1) return prevIdx;
  }
  return doc.rows.findIndex(
    (r) => r.group_id === gid && (r.variant_index ?? 0) === 0,
  );
}

/** Read this stage's prior cumulative cost from the artefact's
 *  metadata. The stage writes its running total to
 *  `metadata_jsonb.image_gen_stage_cost_usd` on every chunk; missing
 *  / unparseable → treat as $0 (fresh entry into the stage). */
function parsePriorStageSpend(metadata: Record<string, unknown>): number {
  const raw = metadata.image_gen_stage_cost_usd;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  return 0;
}

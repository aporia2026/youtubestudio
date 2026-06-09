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
  generateMotionCollage,
  generateMouthRemovedForCharacter,
  generateSceneContinuationImage,
  generateVariantImage,
  isCollageEligibleRow,
  type PipelineCollageCellInput,
  type PipelineImageDoc,
  type PipelineImageRow,
} from '../production-doc-image-gen';
import { extractCharacterAnchors } from '../../anchor-vision-pass';
import { generatePropImage } from '../../prop-generation';
import { resolveStyle } from '../../production-doc-styles';
import { loadStyleReferences, mirrorPublicUrlRefToR2 } from '../../production-doc-styles-refs';
import {
  findMissingPanelIndices,
  pickMotionCollageChunkSize,
  resolveI2iModelForRow,
} from '../../image-models-i2i';
import { getDownloadUrlForBucket } from '../../r2';
import {
  classifyImageGenError,
  isExhausted,
  RETRY_BUDGETS,
} from '../image-gen-errors';

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

/** Hard cap on how many fresh Atlas T2I prop generations a single
 *  tick can run. Each call is ~15–25 s; 3 keeps the worst-case tick
 *  comfortably under the Vercel 300 s budget (mouth-removed + vision
 *  pass + prop gen all share the same MAX_*_PER_TICK = 3 ceiling).
 *  Deferred entries come back next tick — the prop_slide beat's
 *  propPromptHint is still missing from the doc's prop cache. */
const MAX_PROP_GEN_PER_TICK = 3;

/** Hard cap on how many doodle_explainer_2 motion_collage rows this
 *  tick processes. Lower than MAX_MOUTH_REMOVED_PER_TICK because each
 *  motion_collage call is heavier: Atlas T2I against a more elaborate
 *  prompt (~60-90 s) + Recraft 4× upscale on a ~4K target (~30 s) +
 *  sharp slice into N panels (~5 s) ≈ ~125 s worst case. Two rows per
 *  tick leaves a ~50 s headroom under the Vercel 300 s budget even
 *  alongside other work. Rows deferred by this cap come back next tick
 *  via the same retry pattern (image_url still empty triggers re-pick). */
const MAX_MOTION_COLLAGE_PER_TICK = 2;

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

/** Per-tick deadline. Vercel's function maxDuration is 300s; we bail
 *  out of the row loop when we've used ~85% of that so the persist +
 *  cleanup at the end has comfortable headroom. Without this guard,
 *  one slow Kie poll (up to 285s by itself per kie-poll.ts) could
 *  blow the entire tick, returning HTTP 504 and silently re-trying
 *  the same work next tick. 2026-06-08 bugfix. */
const TICK_DEADLINE_BUDGET_MS = 255_000;

export async function handleGenerateProductionDocImages(
  ctx: StageHandlerContext,
): Promise<StageOutcome> {
  const { video } = ctx;
  const tickStartedAtMs = Date.now();
  const deadlineExceeded = (): boolean => Date.now() - tickStartedAtMs > TICK_DEADLINE_BUDGET_MS;

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
  // pipeline_stage_artefacts has NO `id` column — its primary key is
  // composite (pipeline_run_video_id, stage, attempt_number, artefact_kind).
  // Pull the attempt_number back so the UPDATE later can target the
  // exact row via the composite PK. Bug 2026-06-08: previous SELECT
  // referenced psa.id and threw "column psa.id does not exist".
  const { rows: artefactRows } = await sql.query<{
    attempt_number: number;
    metadata_jsonb: Record<string, unknown> | null;
  }>(
    `
    SELECT psa.attempt_number, psa.metadata_jsonb
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
  const artefactAttemptNumber = artefactRows[0].attempt_number;
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
  //    image_url (idempotent re-entry) or no usable prompt source.
  //
  //    A "usable prompt source" is either a non-empty `ai_image_prompt`
  //    (regular base rows, including doodle_explainer_2 + paint_explainer_v1
  //    standalone shots) OR a `shot_kind === 'motion_collage'` row with
  //    its `motion_collage_panel_prompts` populated. The motion_collage
  //    path uses a different prompt source per the new shot kind — see
  //    `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.
  const baseIndicesToGen: number[] = [];
  const variantIndicesToGen: number[] = [];
  let exhaustedRowCount = 0;
  doc.rows.forEach((row, i) => {
    if (row.image_url?.trim()) return;
    // PR2 circuit breaker (2026-06-03): a row past its per-error-class
    // retry budget stays out of the plan until the user clicks Retry
    // (which clears `attempts` + `last_error`). Without this, a row
    // whose prompt deterministically violates content policy would
    // grind through the stage's $10 cost cap one Atlas call at a time
    // — that's the "too many failures / too many retries" pattern the
    // user reported.
    if (row.last_error && isExhausted(row.attempts, row.last_error.class)) {
      exhaustedRowCount += 1;
      return;
    }
    const prompt = (row.ai_image_prompt ?? '').trim();
    const variantIdx = row.variant_index ?? 0;
    if (variantIdx === 0) {
      // Base / standalone — needs a non-empty prompt source. Motion
      // collage rows carry their content in `motion_collage_panel_prompts`
      // instead of `ai_image_prompt`; admit them here so the per-item
      // loop's motion_collage branch can pick them up.
      const isMotionCollage = row.shot_kind === 'motion_collage';
      if (!prompt && !isMotionCollage) return;
      baseIndicesToGen.push(i);
    } else {
      // Variant — needs a non-empty variant_edit_prompt. Source
      // readiness is checked just-in-time inside the loop below
      // (the source might be generated earlier in this same tick).
      if (!row.variant_edit_prompt?.trim()) return;
      variantIndicesToGen.push(i);
    }
  });
  if (exhaustedRowCount > 0) {
    logger.info('[image-gen circuit-breaker] rows skipped (past retry budget)', {
      pipeline_video_id: video.id,
      exhausted_count: exhaustedRowCount,
      total_rows: doc.rows.length,
    });
  }

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
  // doc has the same style. Refs-bearing styles route through the
  // refs-aware collage path (Atlas i2i, see
  // `_plans/2026-05-31-doodle-explainer-2-motion-collage.md` §C);
  // refs-less styles take the original t2i collage path. For
  // paint_explainer_v1 we skip collage entirely either way — the
  // motion-beat / mouth-removed chain depends on a single coherent
  // base frame per character, which a sliced collage quadrant can't
  // reliably provide.
  let styleHasRefs = false;
  let refImageUrls: string[] = [];
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
        if (styleHasRefs) {
          // Resolve every ref to a fetchable URL. Built-in refs (e.g.
          // doodle_explainer_2) go through `mirrorPublicUrlRefToR2`
          // which mirrors the bundled file into R2 once and returns a
          // presigned URL; DB-backed saved-style refs presign directly.
          // Capped to the Atlas i2i 4-ref limit inside
          // `generateCollageGroup` — we resolve all of them here so the
          // function can pick the first 4 by declaration order.
          try {
            refImageUrls = await Promise.all(
              refs.map((r) =>
                r.public_url
                  ? mirrorPublicUrlRefToR2(r)
                  : getDownloadUrlForBucket(r.r2_bucket, r.r2_key, undefined),
              ),
            );
          } catch (err) {
            logger.warn('[pipeline image-gen collage] ref-url resolution failed — falling back to t2i', {
              pipeline_video_id: video.id,
              error: err instanceof Error ? err.message : String(err),
            });
            // Defensive — t2i still works, just without style anchoring.
            refImageUrls = [];
          }
        }
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
  // 2026-05-31 — motion_collage counters. All zero on docs that don't
  // contain any motion_collage rows. Surfaced in the per-tick summary
  // log so cost attribution is visible at a glance. Deferred rows (the
  // per-tick cap kicks them to the next tick) bump `attempted` but not
  // `succeeded`/`failed`; counting deferred separately keeps the
  // success-rate math honest.
  let motionCollageThisTick = 0;
  let motionCollageSucceeded = 0;
  let motionCollageFailed = 0;
  // 2026-06-09 Phase 2 — counts rows that made progress this tick but
  // still have missing panels. Distinct from succeeded (row fully done)
  // and failed (chunk threw). Surfaced in the tick summary so the
  // operator can tell "9-panel collage being processed across N ticks"
  // from "stuck" without grepping per-row logs.
  let motionCollagePartial = 0;
  let motionCollageDeferred = 0;

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
      workspaceId: video.workspace_id,
      // Refs-aware mode: when the style ships with refs (e.g.
      // doodle_explainer_2's 4 built-in doodle anchors), every cell of
      // the 2×2 output inherits the style consistently via Atlas i2i.
      // Otherwise the call defaults to the original t2i path. Plan §C.
      refImageUrls: refImageUrls.length > 0 ? refImageUrls : undefined,
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

  let deadlineHitDeferredCount = 0;
  for (const item of plan) {
    // Tick-deadline guard. Each row's image-gen call goes through
    // pollKieResult which can take up to 285s on a slow Kie task
    // (95 attempts × 3s interval per kie-poll.ts). If we're close to
    // the Vercel function ceiling, defer the remaining plan to the
    // next tick rather than rolling the dice on a 504. The work done
    // so far gets persisted by the UPDATE at the end of the handler.
    if (deadlineExceeded()) {
      deadlineHitDeferredCount = plan.length - plan.indexOf(item);
      logger.warn('[pipeline image-gen] tick deadline reached; deferring remaining rows', {
        pipeline_video_id: video.id,
        deferred: deadlineHitDeferredCount,
        elapsed_ms: Date.now() - tickStartedAtMs,
        budget_ms: TICK_DEADLINE_BUDGET_MS,
      });
      break;
    }
    const row: PipelineImageRow = doc.rows[item.index];

    // ─── doodle_explainer_2 motion_collage routing ────────────────────
    // Runs BEFORE the character / scene cache paths because motion_collage
    // shots have their own routing logic: panel 0 chooses among
    // (a) Atlas Edit on a cached character/scene base, (b) Atlas i2i
    // with style refs, or (c) Atlas t2i fallback. Panels 1..N always
    // chain Atlas Edit on the previous panel.
    //
    // Cache precedence matches the regular row dispatcher: character_cache
    // wins over scene_cache when both hit. The cached base anchors
    // identity across non-consecutive rows; the chained Edit propagation
    // preserves that anchor through the motion arc.
    //
    // Per-tick cap: MAX_MOTION_COLLAGE_PER_TICK. Deferred rows return
    // next tick (image_url still empty triggers the partition re-pick).
    // Plan: _plans/2026-05-31-doodle-explainer-2-motion-collage.md.
    if (item.kind === 'base' && row.shot_kind === 'motion_collage') {
      if (motionCollageThisTick >= MAX_MOTION_COLLAGE_PER_TICK) {
        motionCollageDeferred += 1;
        logger.info('[motion-collage pipeline] deferred to next tick', {
          pipeline_video_id: video.id,
          row_index: item.index,
          cap: MAX_MOTION_COLLAGE_PER_TICK,
        });
        continue;
      }
      motionCollageThisTick += 1;

      // Resolve a cache hit for panel 0. Character wins over scene
      // (same rule the regular dispatcher applies — Atlas Edit can
      // anchor only one source per call, character identity is the
      // higher-stakes anchor).
      let panel0SourceUrl: string | undefined;
      let cacheKind: 'character' | 'scene' | 'none' = 'none';
      if (isDoodleExplainer2) {
        const cid = row.character_id?.trim();
        const sid = row.scene_id?.trim();
        if (cid) {
          const cached = doc.doodle_explainer_2_character_cache?.[cid];
          if (cached?.base_url) {
            panel0SourceUrl = cached.base_url;
            cacheKind = 'character';
          }
        }
        if (!panel0SourceUrl && sid) {
          const cached = doc.doodle_explainer_2_scene_cache?.[sid];
          if (cached?.base_url) {
            panel0SourceUrl = cached.base_url;
            cacheKind = 'scene';
          }
        }
        if (panel0SourceUrl) {
          logger.info('[motion-collage pipeline] base-cache hit', {
            pipeline_video_id: video.id,
            row_index: item.index,
            cache_kind: cacheKind,
            character_id: cid,
            scene_id: sid,
          });
        }
      }

      // ─── Chunked progress (Phase 2 of 2026-06-09-motion-collage-async-bulk-regen.md) ──
      // A motion-collage row's per-call duration (~150 s for 4 Atlas
      // panels, ~660 s for 9 Kie panels) can exceed a single tick's
      // 255 s budget. Splitting the work across multiple ticks via the
      // existing `panelIndices` + `existingPanelUrls` partial-regen
      // machinery lets large grids on slow vendors complete reliably.
      //
      //   Atlas: 4 panels/chunk (~150 s)
      //   Kie:   3 panels/chunk (~210 s)
      //
      // Each tick:
      //   - Compute missing panels from the row's sparse
      //     `motion_collage_panel_urls`.
      //   - If empty → row already complete; promote `image_url` so
      //     partition skips it (defensive recovery from corrupted state).
      //   - Otherwise → take the first `chunkSize` missing indices,
      //     pad the existing-URLs array to N, call generateMotionCollage
      //     with the partial-regen contract.
      //   - On success: merge URLs back; if all N panels are now
      //     populated, set `image_url` + `motion_collage_image_url` so
      //     the next tick's partition skips this row.
      //   - On failure: leave existing URLs intact; next tick retries
      //     the same chunk.
      const grid = row.motion_collage_grid;
      const N = grid && Number.isInteger(grid.cols) && Number.isInteger(grid.rows)
        ? grid.cols * grid.rows
        : 0;
      if (N === 0) {
        logger.warn('[motion-collage tick] no grid; row skipped', {
          pipeline_video_id: video.id,
          row_index: item.index,
        });
        motionCollageFailed += 1;
        failed += 1;
        continue;
      }
      const existingPanelUrls = (row.motion_collage_panel_urls ?? []) as string[];
      const missingIndices = findMissingPanelIndices(existingPanelUrls, N);
      if (missingIndices.length === 0) {
        // Defensive recovery: every panel is filled but image_url was
        // somehow still empty (corrupted state, or a manual clear that
        // missed image_url). Promote so the partition skips this row.
        doc.rows[item.index].motion_collage_panel_urls = existingPanelUrls;
        doc.rows[item.index].image_url = existingPanelUrls[0];
        if (!doc.rows[item.index].motion_collage_image_url) {
          doc.rows[item.index].motion_collage_image_url = existingPanelUrls[0];
        }
        motionCollageSucceeded += 1;
        succeeded += 1;
        logger.info('[motion-collage tick] row already complete; promoted', {
          pipeline_video_id: video.id,
          row_index: item.index,
          total_panels: N,
        });
        continue;
      }
      // Resolve the vendor so chunk size matches it. The style preset
      // lookup here is independent of generateMotionCollage's own
      // internal resolution — both must agree to keep telemetry honest.
      // Failure here is non-fatal (resolveI2iModelForRow falls through
      // to the default chunk size).
      const pickedModelForRow = row.image_model_override || doc.image_model_default;
      let stylePref: string | undefined;
      const styleSlug = doc.style_preset?.trim();
      if (styleSlug) {
        try {
          const style = await resolveStyle(styleSlug, video.workspace_id);
          stylePref = style?.preferred_cloud_model ?? undefined;
        } catch (err) {
          logger.warn('[motion-collage tick] style lookup failed; using default chunk size', {
            pipeline_video_id: video.id,
            row_index: item.index,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const resolvedI2i = resolveI2iModelForRow({
        rowPickedModel: pickedModelForRow,
        stylePreferred: stylePref,
      });
      const chunkSize = pickMotionCollageChunkSize(resolvedI2i.i2iModel);
      const chunk = missingIndices.slice(0, chunkSize);
      // Decide path: full-generation (all panels missing AND chunk
      // covers the whole grid) vs. partial-regen (some panels exist
      // from prior ticks OR chunk is a subset of N).
      const isFullCover =
        existingPanelUrls.every((u) => !u || u.length === 0)
        && chunk.length === N;
      logger.info('[motion-collage tick]', {
        pipeline_video_id: video.id,
        row_index: item.index,
        total_panels: N,
        existing_panels: N - missingIndices.length,
        missing_panels: missingIndices.length,
        chunk_size: chunk.length,
        chunk_indices: chunk,
        resolved_i2i_model: resolvedI2i.i2iModel,
        model_source: resolvedI2i.source,
        path: isFullCover ? 'full-cover' : 'partial-regen',
      });
      // The partial-regen path needs a full-length existingPanelUrls
      // array. Pad with empty strings for missing slots — the chain-
      // aware validator in generateMotionCollage (Phase 2 R2) accepts
      // empties for slots that aren't a chain dependency of the
      // current regen set.
      const paddedExisting: string[] = Array.from(
        { length: N },
        (_, i) => existingPanelUrls[i] ?? '',
      );
      const mc = isFullCover
        ? await generateMotionCollage({
            row,
            doc,
            workspaceId: video.workspace_id,
            panel0SourceUrl,
            pickedModel: pickedModelForRow,
          })
        : await generateMotionCollage({
            row,
            doc,
            workspaceId: video.workspace_id,
            panel0SourceUrl,
            pickedModel: pickedModelForRow,
            panelIndices: chunk,
            existingPanelUrls: paddedExisting,
          });
      tickCostUsd += mc.costUsd;
      if (mc.panelUrls && mc.panelUrls.length > 0) {
        // Merge: `mc.panelUrls` is full-length-N. For the partial-regen
        // path, non-regen slots come through as passthroughs of
        // paddedExisting (so the merge is a no-op for them); regen slots
        // carry the new URLs. For the full-cover path every slot is
        // freshly generated. Either way, the returned array IS the new
        // sparse / dense state of the row.
        const mergedPanelUrls = mc.panelUrls;
        doc.rows[item.index].motion_collage_panel_urls = mergedPanelUrls;
        // 2026-06-10 caveat fix — clear any prior chunk-failure
        // breadcrumbs now that this chunk made progress. Without this,
        // a row that hits a transient failure on tick 1 (attempts=1,
        // last_error set) and succeeds on tick 2 would still carry the
        // stale error through the partition's circuit breaker. The
        // breaker is supposed to gate persistent failures, not penalize
        // recovery.
        delete doc.rows[item.index].attempts;
        delete doc.rows[item.index].last_error;
        // 2026-06-10 caveat fix — cache write-back fires AS SOON AS
        // panel 0 is freshly generated, not only on full-row completion.
        // Without this, a 9-panel row that takes 3 ticks left the
        // character cache empty for tick 1 + tick 2, so a SIBLING row
        // with the same character_id processed in tick 2 would
        // re-generate its own panel 0 (cache miss) instead of anchoring
        // on the now-already-rendered URL. Visual drift between
        // siblings. The check is idempotent — the `if (!cache[cid]?.base_url)`
        // guard inside skips a write when another row already seeded
        // the slot.
        const panel0FreshlyGenerated = chunk.includes(0) && typeof mergedPanelUrls[0] === 'string' && mergedPanelUrls[0].length > 0;
        if (isDoodleExplainer2 && cacheKind === 'none' && panel0FreshlyGenerated) {
          const cid = row.character_id?.trim();
          const sid = row.scene_id?.trim();
          if (cid) {
            const charCache = doc.doodle_explainer_2_character_cache ?? {};
            if (!charCache[cid]?.base_url) {
              charCache[cid] = {
                base_url: mergedPanelUrls[0],
                first_seen_row_index: item.index,
              };
              doc.doodle_explainer_2_character_cache = charCache;
              charCacheMisses += 1;
              logger.info('[motion-collage pipeline] character-cache miss-and-store', {
                pipeline_video_id: video.id,
                row_index: item.index,
                character_id: cid,
              });
            }
          }
          if (sid) {
            const sceneCache = doc.doodle_explainer_2_scene_cache ?? {};
            if (!sceneCache[sid]?.base_url) {
              sceneCache[sid] = {
                base_url: mergedPanelUrls[0],
                first_seen_row_index: item.index,
              };
              doc.doodle_explainer_2_scene_cache = sceneCache;
              sceneCacheMisses += 1;
              logger.info('[motion-collage pipeline] scene-cache miss-and-store', {
                pipeline_video_id: video.id,
                row_index: item.index,
                scene_id: sid,
              });
            }
          }
        } else if (isDoodleExplainer2 && cacheKind === 'character') {
          charCacheHits += 1;
        } else if (isDoodleExplainer2 && cacheKind === 'scene') {
          sceneCacheHits += 1;
        }
        const stillMissing = findMissingPanelIndices(mergedPanelUrls, N);
        if (stillMissing.length === 0) {
          // Row complete — write the final sentinels so partition
          // skips this row next tick + downstream UI surfaces show
          // panel 0 as the row thumbnail.
          doc.rows[item.index].motion_collage_image_url = mc.collageImageUrl;
          doc.rows[item.index].image_url = mergedPanelUrls[0];
          motionCollageSucceeded += 1;
          succeeded += 1;
          logger.info('[motion-collage pipeline] row complete', {
            pipeline_video_id: video.id,
            row_index: item.index,
            total_panels: N,
          });
        } else {
          // Chunk succeeded but the row still has missing panels.
          // Don't count it as success or failure yet — next tick will
          // pick up the remaining panels via the same partition logic
          // (image_url stays empty until completion).
          motionCollagePartial += 1;
          logger.info('[motion-collage pipeline] row partial — will resume next tick', {
            pipeline_video_id: video.id,
            row_index: item.index,
            total_panels: N,
            completed_panels: N - stillMissing.length,
            remaining_panels: stillMissing.length,
            remaining_indices: stillMissing,
          });
        }
      } else {
        // 2026-06-10 caveat fix — write attempts + last_error on chunk
        // failure so the partition's circuit breaker (line 222) can
        // gate a row whose chunks keep failing for the same reason.
        // Previously motion-collage chunks logged the failure but
        // didn't write the breadcrumbs, so a row with a deterministic
        // failure (e.g. content policy on a panel prompt) would retry
        // forever, eating one chunk's worth of cost each tick.
        const classified = classifyImageGenError(mc.error ?? 'unknown_failure');
        const priorAttempts = typeof row.attempts === 'number' ? row.attempts : 0;
        doc.rows[item.index].attempts = priorAttempts + 1;
        doc.rows[item.index].last_error = {
          class: classified.class,
          message: classified.message,
          at: new Date().toISOString(),
        };
        motionCollageFailed += 1;
        failed += 1;
        logger.warn('[motion-collage pipeline] chunk failed', {
          pipeline_video_id: video.id,
          row_index: item.index,
          attempts: priorAttempts + 1,
          error_class: classified.class,
          chunk_indices: chunk,
          error: mc.error,
          duration_ms: mc.durationMs,
        });
      }
      continue;
    }

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
        workspaceId: video.workspace_id,
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
        workspaceId: video.workspace_id,
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
          : await generateVariantImage({ row, doc, workspaceId: video.workspace_id });
    }
    tickCostUsd += result.costUsd;
    if (result.imageUrl) {
      // Mutate the in-memory doc so subsequent variants in this same
      // tick see the new image_url when checking their source.
      doc.rows[item.index].image_url = result.imageUrl;
      // PR2: clear any prior failure state so the UI chip disappears
      // on a successful retry. Attempts intentionally preserved as a
      // forensic counter — useful when debugging "why did this row
      // take so many tries."
      if (doc.rows[item.index].last_error) {
        doc.rows[item.index].last_error = null;
      }
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
      // PR2 (2026-06-03): classify the raw error, persist it on the
      // row, and let the next tick's plan-build decide whether to
      // retry or skip via `isExhausted`. The classifier sanitizes
      // the message before write so credentials / paths / customer
      // ids don't end up rendered to the client.
      const classified = classifyImageGenError(result.error);
      const currentRow = doc.rows[item.index];
      currentRow.attempts = (currentRow.attempts ?? 0) + 1;
      currentRow.last_error = {
        class: classified.class,
        message: classified.message,
        at: new Date().toISOString(),
      };
      const budget = RETRY_BUDGETS[classified.class];
      const decision = currentRow.attempts >= budget ? 'give-up' : 'retry';
      logger.warn('[image-gen retry]', {
        pipeline_video_id: video.id,
        row_index: item.index,
        kind: item.kind,
        error_class: classified.class,
        error_message: classified.message,
        attempts: currentRow.attempts,
        budget,
        decision,
        duration_ms: result.durationMs,
      });
    }
  }

  // ─── paint_explainer_v1 prop generation pass ─────────────────────
  //
  // After the per-row loop completes, walk every row's prop_slide
  // beats and collect the propPromptHints that aren't in the doc's
  // prop cache yet. For each unique hint (deduplicated — the same
  // hint reused across multiple beats pays for one generation), fire
  // an Atlas T2I call up to MAX_PROP_GEN_PER_TICK. Cache the URL on
  // doc.paint_explainer_v1_prop_cache. The renderer reads from there
  // via productionDocToVideoConfig at render time.
  //
  // No-op on non-paint_explainer_v1 docs (the dedupe walks every row
  // but the kind filter catches nothing). No-op when every hint is
  // already cached (cache hit short-circuits).
  let propGenAttempted = 0;
  let propGenSucceeded = 0;
  let propGenSkipped = 0;
  let propGenFailed = 0;
  if (isPaintExplainerV1 && !deadlineExceeded()) {
    const cache = doc.paint_explainer_v1_prop_cache ?? {};
    // Walk all rows once, collect unique hints not yet in cache.
    const pendingHints = new Set<string>();
    for (const row of doc.rows) {
      if (!Array.isArray(row.motion_beats)) continue;
      for (const beat of row.motion_beats) {
        if (beat?.kind !== 'prop_slide') continue;
        // The motion-beat shape on the row is open per the inline
        // type definition. Cast through unknown to access payload.
        const payload = (beat as { payload?: { propPromptHint?: string; assetUrl?: string } }).payload;
        const hint = payload?.propPromptHint?.trim();
        if (!hint) continue;
        // Skip when the LLM also supplied an assetUrl — the renderer
        // uses that directly without a cache lookup.
        if (typeof payload?.assetUrl === 'string' && payload.assetUrl.length > 0) continue;
        // Skip when already cached.
        if (typeof cache[hint] === 'string' && cache[hint].length > 0) continue;
        pendingHints.add(hint);
      }
    }
    for (const hint of pendingHints) {
      if (propGenAttempted >= MAX_PROP_GEN_PER_TICK) {
        propGenSkipped += 1;
        logger.info('[paint-explainer-v1 prop-generation] deferred to next tick', {
          pipeline_video_id: video.id,
          prompt_hint_head: hint.slice(0, 60),
          cap: MAX_PROP_GEN_PER_TICK,
        });
        continue;
      }
      const result = await generatePropImage({ promptHint: hint });
      propGenAttempted += 1;
      tickCostUsd += result.costUsd;
      if ('url' in result) {
        cache[hint] = result.url;
        propGenSucceeded += 1;
        logger.info('[paint-explainer-v1 prop-generation] cached', {
          pipeline_video_id: video.id,
          prompt_hint_head: hint.slice(0, 60),
          predict_ms: result.durationMs,
          cost_usd: result.costUsd,
        });
      } else {
        propGenFailed += 1;
        logger.warn('[paint-explainer-v1 prop-generation] failed — renderer will skip beat', {
          pipeline_video_id: video.id,
          prompt_hint_head: hint.slice(0, 60),
          error: result.error,
        });
      }
    }
    if (propGenSucceeded > 0 || propGenFailed > 0 || propGenSkipped > 0) {
      doc.paint_explainer_v1_prop_cache = cache;
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
  // Composite-PK UPDATE; mirrors the SELECT above. There is no `id`
  // column on pipeline_stage_artefacts -- 2026-06-08 bugfix.
  await sql.query(
    `
    UPDATE pipeline_stage_artefacts
       SET metadata_jsonb = $1::jsonb
     WHERE pipeline_run_video_id = $2::uuid
       AND stage = 'generating_production_doc'
       AND attempt_number = $3
       AND artefact_kind = 'production_doc'
    `,
    [JSON.stringify(updatedMetadata), video.id, artefactAttemptNumber],
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
        // PR2 circuit breaker: a row past its budget counts as done for
        // advancement purposes. The user must click Retry on the row
        // chip to clear its attempts / last_error and bring it back
        // into the plan. Mirrors the plan-build filter above so the
        // stage's two "is this row pending?" checks agree.
        if (r.last_error && isExhausted(r.attempts, r.last_error.class)) return false;
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
    // paint_explainer_v1 prop-generation sub-stage telemetry.
    prop_gen_attempted: propGenAttempted,
    prop_gen_succeeded: propGenSucceeded,
    prop_gen_skipped: propGenSkipped,
    prop_gen_failed: propGenFailed,
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
    // 2026-05-31 motion_collage telemetry. All zero on docs without
    // any motion_collage rows. `deferred` counts rows the tick cap
    // kicked to the next tick — they ALSO show up in the partition
    // next tick (image_url still empty), so the success rate over the
    // whole job is `succeeded / (succeeded + failed)`, not
    // `succeeded / attempted`.
    motion_collage_attempted: motionCollageThisTick,
    motion_collage_succeeded: motionCollageSucceeded,
    motion_collage_partial: motionCollagePartial,
    motion_collage_failed: motionCollageFailed,
    motion_collage_deferred: motionCollageDeferred,
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

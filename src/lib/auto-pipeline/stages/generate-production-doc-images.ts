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
  generateMouthRemovedForCharacter,
  generateVariantImage,
  type PipelineImageDoc,
  type PipelineImageRow,
} from '../production-doc-image-gen';

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

  // 5) Build this tick's plan — bases first up to ROWS_PER_TICK,
  //    then variants whose source is ready (or will be ready
  //    in-tick). Order is stable: base index ascending, then variant
  //    index ascending.
  const rowsPerTick = isPaintExplainerV1
    ? ROWS_PER_TICK_PAINT_EXPLAINER_V1
    : ROWS_PER_TICK_DEFAULT;
  const plan: Array<{ index: number; kind: 'base' | 'variant' }> = [];
  for (const idx of baseIndicesToGen) {
    if (plan.length >= rowsPerTick) break;
    plan.push({ index: idx, kind: 'base' });
  }
  // Track which row indices will have image_url by the time variants
  // run (in-tick). The variant readiness check is conservative — only
  // queues a variant when its source is already in the doc; variants
  // whose source is in THIS tick's base plan get deferred to the
  // next tick (avoids reading-while-writing the same doc structure).
  const inFlightBaseIndices = new Set(plan.map((p) => p.index));
  for (const idx of variantIndicesToGen) {
    if (plan.length >= rowsPerTick) break;
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
  let mouthRemovedThisTick = 0;
  let mouthRemovedSucceeded = 0;
  let mouthRemovedSkipped = 0;
  let mouthRemovedFailed = 0;
  for (const item of plan) {
    const row = doc.rows[item.index];
    const result =
      item.kind === 'base'
        ? await generateBaseImage({
            row,
            doc,
            workspaceId: video.workspace_id,
          })
        : await generateVariantImage({ row, doc });
    tickCostUsd += result.costUsd;
    if (result.imageUrl) {
      // Mutate the in-memory doc so subsequent variants in this same
      // tick see the new image_url when checking their source.
      doc.rows[item.index].image_url = result.imageUrl;
      succeeded += 1;

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
  //    cap and must come back next tick.
  const stillRemaining =
    doc.rows.some((r) => {
      if (!r.image_url?.trim()) {
        const prompt = (r.ai_image_prompt ?? '').trim();
        const variantIdx = r.variant_index ?? 0;
        if (variantIdx === 0) return prompt.length > 0;
        return Boolean(r.variant_edit_prompt?.trim());
      }
      // Base / variant image already generated. For paint_explainer_v1,
      // also check whether a mouth-removed companion is still pending.
      if (isPaintExplainerV1 && needsMouthRemoved(r) && r.character_id && !r.mouth_removed_url?.trim()) {
        return true;
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
 *  code path accidentally calls this helper. */
function needsMouthRemoved(row: PipelineImageRow): boolean {
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

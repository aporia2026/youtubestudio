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
  generateVariantImage,
  type PipelineImageDoc,
  type PipelineImageRow,
} from '../production-doc-image-gen';

/** Max rows to attempt per tick. Sized so the worst-case Atlas i2i
 *  latency (~30 s) × 8 rows = ~240 s stays under the Vercel 300 s
 *  function timeout with headroom for the per-tick DB read/write. */
const ROWS_PER_TICK = 8;

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
  const { rows: artefactRows } = await sql.query<{
    id: string;
    metadata_jsonb: Record<string, unknown> | null;
  }>(
    `
    SELECT id::text AS id, metadata_jsonb
      FROM pipeline_stage_artefacts
     WHERE pipeline_run_video_id = $1::uuid
       AND stage = 'generating_production_doc'
       AND artefact_kind = 'production_doc'
     ORDER BY attempt_number DESC
     LIMIT 1
    `,
    [video.id],
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
  //    ($0.04 / base, $0.011 / variant edit).
  const COST_PER_BASE = 0.04;
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
  const plan: Array<{ index: number; kind: 'base' | 'variant' }> = [];
  for (const idx of baseIndicesToGen) {
    if (plan.length >= ROWS_PER_TICK) break;
    plan.push({ index: idx, kind: 'base' });
  }
  // Track which row indices will have image_url by the time variants
  // run (in-tick). The variant readiness check is conservative — only
  // queues a variant when its source is already in the doc; variants
  // whose source is in THIS tick's base plan get deferred to the
  // next tick (avoids reading-while-writing the same doc structure).
  const inFlightBaseIndices = new Set(plan.map((p) => p.index));
  for (const idx of variantIndicesToGen) {
    if (plan.length >= ROWS_PER_TICK) break;
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
  const stillRemaining =
    doc.rows.some((r) => {
      if (r.image_url?.trim()) return false;
      const prompt = (r.ai_image_prompt ?? '').trim();
      const variantIdx = r.variant_index ?? 0;
      if (variantIdx === 0) return prompt.length > 0;
      return Boolean(r.variant_edit_prompt?.trim());
    });

  logger.info('auto-pipeline: production-doc-images tick complete', {
    pipeline_video_id: video.id,
    plan_size: plan.length,
    succeeded,
    failed,
    tick_cost_usd: tickCostUsd,
    cumulative_cost_usd: alreadySpentUsd + tickCostUsd,
    still_remaining: stillRemaining,
  });

  return {
    kind: 'advance',
    nextStage: stillRemaining ? 'generating_production_doc_images' : 'generating_thumbnail',
    costUsd: tickCostUsd,
  };
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

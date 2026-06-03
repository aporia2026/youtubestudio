/**
 * Shorts style-asset background runner (Phase 15.16).
 *
 * Drives claimed Shorts through plan → base → variants → done across cron
 * ticks, replacing the old all-in-one synchronous route that blew the 300s
 * budget whenever a vendor leg was slow and discarded every completed
 * variant when Vercel hard-killed it. See
 * `_plans/2026-06-03-shorts-asset-generation-reliability.md`.
 *
 * Why this fixes the root cause:
 *   - Work is bounded per tick (TICK_BUDGET_MS) and persists incrementally,
 *     so nothing is ever hard-killed mid-flight and no finished work is lost.
 *   - A lease (claimed_at) means a tick that dies strands nothing — the next
 *     tick reclaims the row after the lease lapses and finishes it. Stuck
 *     jobs heal themselves.
 *   - Variants run in bounded-concurrency batches (fast) and a single
 *     failing variant is retried up to a cap, then skipped — the Short
 *     finalizes with whatever succeeded (partial success by design).
 *   - Every attempt logs its outcome + classified reason, and the last
 *     error is persisted per variant, so a future stall explains itself.
 *
 * The cron route (`/api/cron/run-shorts-assets`) calls `runShortsAssetDrain`
 * under a single-flight advisory lock; this module owns all the DB + vendor
 * orchestration. The pure next-step decision lives in `shorts-asset-job.ts`.
 */

import { sql } from './db';
import { logger } from './logger';
import { withCronLock, CRON_LOCK_KEYS, type CronLockOutcome } from './cron-lock';
import { splitScriptIntoCaptions } from './shorts-render';
import {
  WORDS_PER_SECOND,
  type GenerationProgressState,
  type ShortsAssetJobState,
  type ShortStyleAssets,
  type ShortFrameVariant,
} from './shorts-types';
import { selectNextAction, type JobView, type VariantPlanItem } from './shorts-asset-job';
import {
  planDoodleAssets,
  generateDoodleBaseFrame,
  generateDoodleVariantFrame,
} from './shorts-doodle-asset-pipeline';
import {
  planPaintAssets,
  generatePaintBaseFrame,
  generatePaintVariantFrame,
} from './shorts-paint-asset-pipeline';
import { resolveBaseT2iModelId } from './shorts-base-t2i';

/** A claim older than this is reclaimable — covers tick death. Generous
 *  enough that a live, slow tick (base 30-60s + a variant batch) never
 *  loses its own lease, since the cron is single-flight per invocation. */
const LEASE_SECONDS = 90;
/** Stop starting new work past this many ms into a tick, just under the
 *  300s function ceiling, so we yield + persist instead of being killed. */
const TICK_BUDGET_MS = 280_000;
/** Variants generated concurrently per batch. A typical Short plans ~6, so
 *  this fires them all at once — variants are independent edits off one base
 *  frame, and running them concurrently (rather than 3 at a time) roughly
 *  halves the wall-clock. A per-variant attempt cap + the Kie/Atlas fallback
 *  absorb the occasional 429 from the wider burst. */
const MAX_VARIANTS_PER_BATCH = 6;

type StyleKey = 'doodle' | 'paint';

interface ClaimedShort {
  id: string;
  workspace_id: string;
  short_script: string;
  style_id: string | null;
  project_id: string | null;
  voiceover_duration_seconds: number | null;
  estimated_duration_seconds: number | null;
  word_count: number | null;
  hook: string | null;
  payoff: string | null;
  title: string | null;
  style_assets: ShortStyleAssets | null;
  generation_progress: GenerationProgressState | null;
}

export type TickOutcome =
  | 'done'
  | 'error'
  | 'yielded' // tick budget hit — stop claiming this tick, resume next
  | 'deferred' // retryable variants remain — keep lease, let drain serve others
  | 'skipped';

/** Scrub URLs out of a vendor error before persisting it to the row — the
 *  same posture as the alignment cache. The namespaced log line keeps the
 *  full detail; the stored summary is user-facing. */
function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/https?:\/\/\S+/g, '<url>').slice(0, 240);
}

function styleKeyFor(styleId: string | null | undefined): StyleKey | null {
  if (styleId === 'doodle_explainer_2_short') return 'doodle';
  if (styleId === 'paint_explainer_v1_short') return 'paint';
  return null;
}

/** Caption chunks the variants align to — must match what the renderer
 *  computes (`buildShortVideoConfig`), so the same seconds heuristic. */
function captionsFor(short: ClaimedShort) {
  const seconds =
    short.voiceover_duration_seconds
    ?? short.estimated_duration_seconds
    ?? Math.max(15, Math.round((short.word_count ?? 0) / WORDS_PER_SECOND));
  return splitScriptIntoCaptions(short.short_script, seconds * 1000);
}

/** Atomically claim the oldest queued / in-flight Short whose lease is free.
 *  `FOR UPDATE SKIP LOCKED` + the lease window are belt-and-suspenders: the
 *  cron is already single-flight, but this keeps the claim correct even if
 *  that ever changes. */
async function claimNextShort(tickId: string): Promise<ClaimedShort | null> {
  const { rows } = await sql<ClaimedShort>`
    UPDATE shorts
       SET generation_claimed_at = NOW(),
           generation_claimed_by_tick = ${tickId}
     WHERE id = (
       SELECT id FROM shorts
        WHERE generation_progress->>'phase' IN ('queued', 'planning', 'base', 'variant')
          AND (
            generation_claimed_at IS NULL
            OR generation_claimed_at < NOW() - make_interval(secs => ${LEASE_SECONDS})
          )
          AND short_script IS NOT NULL
        ORDER BY (generation_progress->>'started_at') ASC NULLS FIRST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id::text, workspace_id::text, short_script, style_id, project_id::text,
               voiceover_duration_seconds, estimated_duration_seconds, word_count,
               hook, payoff, title, style_assets, generation_progress
  `;
  return rows[0] ?? null;
}

/** Claim ONE specific Short, scoped to its workspace — for the client-driven
 *  tick, which must never touch another tenant's row (the cron's global claim
 *  is system-only). Same lease semantics. */
async function claimSpecificShort(
  shortId: string,
  workspaceId: string,
  tickId: string,
): Promise<ClaimedShort | null> {
  const { rows } = await sql<ClaimedShort>`
    UPDATE shorts
       SET generation_claimed_at = NOW(),
           generation_claimed_by_tick = ${tickId}
     WHERE id = ${shortId}::uuid
       AND workspace_id = ${workspaceId}::uuid
       AND generation_progress->>'phase' IN ('queued', 'planning', 'base', 'variant')
       AND (
         generation_claimed_at IS NULL
         OR generation_claimed_at < NOW() - make_interval(secs => ${LEASE_SECONDS})
       )
       AND short_script IS NOT NULL
     RETURNING id::text, workspace_id::text, short_script, style_id, project_id::text,
               voiceover_duration_seconds, estimated_duration_seconds, word_count,
               hook, payoff, title, style_assets, generation_progress
  `;
  return rows[0] ?? null;
}

/** Persist a mid-flight checkpoint: progress + assets + lease heartbeat in
 *  one write. `started_at` is preserved from the enqueue so the client's
 *  elapsed math + the staleness deadline stay anchored. */
async function persistCheckpoint(
  short: ClaimedShort,
  tickId: string,
  progress: GenerationProgressState,
  assets: ShortStyleAssets,
): Promise<void> {
  const startedAt = short.generation_progress?.started_at ?? new Date().toISOString();
  const merged: GenerationProgressState = {
    ...progress,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
  };
  await sql`
    UPDATE shorts
       SET generation_progress = ${JSON.stringify(merged)}::jsonb,
           style_assets = ${JSON.stringify(assets)}::jsonb,
           generation_claimed_at = NOW(),
           generation_claimed_by_tick = ${tickId},
           updated_at = NOW()
     WHERE id = ${short.id}::uuid AND workspace_id = ${short.workspace_id}::uuid
  `;
}

/** Terminal success: stamp the style, persist final assets, clear the
 *  in-flight progress + lease so the editor stops polling fast. */
async function finalizeDone(
  short: ClaimedShort,
  styleId: string,
  assets: ShortStyleAssets,
): Promise<void> {
  await sql`
    UPDATE shorts
       SET style_id = ${styleId},
           style_assets = ${JSON.stringify(assets)}::jsonb,
           generation_progress = '{}'::jsonb,
           generation_claimed_at = NULL,
           generation_claimed_by_tick = NULL,
           updated_at = NOW()
     WHERE id = ${short.id}::uuid AND workspace_id = ${short.workspace_id}::uuid
  `;
}

/** Terminal failure: surface an error the user can read + Retry. Keeps any
 *  partial assets (e.g. a paid base frame) so a retry resumes instead of
 *  restarting. Releases the lease. */
async function finalizeError(
  short: ClaimedShort,
  styleId: string,
  assets: ShortStyleAssets,
  message: string,
): Promise<void> {
  const startedAt = short.generation_progress?.started_at ?? new Date().toISOString();
  const progress: GenerationProgressState = {
    phase: 'error',
    label: 'Asset generation failed.',
    error_message: message,
    style_id: styleId,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
  };
  await sql`
    UPDATE shorts
       SET generation_progress = ${JSON.stringify(progress)}::jsonb,
           style_assets = ${JSON.stringify(assets)}::jsonb,
           generation_claimed_at = NULL,
           generation_claimed_by_tick = NULL,
           updated_at = NOW()
     WHERE id = ${short.id}::uuid AND workspace_id = ${short.workspace_id}::uuid
  `;
}

/** Yield the row mid-job (tick budget hit). Clear the lease so the next
 *  tick reclaims it immediately; progress + assets are already persisted. */
async function releaseClaim(short: ClaimedShort): Promise<void> {
  await sql`
    UPDATE shorts
       SET generation_claimed_at = NULL,
           generation_claimed_by_tick = NULL,
           updated_at = NOW()
     WHERE id = ${short.id}::uuid AND workspace_id = ${short.workspace_id}::uuid
  `;
}

function variantLabel(styleKey: StyleKey, done: number, total: number): string {
  const noun = styleKey === 'paint' ? 'Paint' : 'Doodle';
  return `${noun} — generating variant ${Math.min(done + 1, total)} of ${total}…`;
}

/**
 * Drive one claimed Short forward as far as the tick budget allows,
 * persisting after every step. Returns the terminal/yield outcome.
 */
async function processClaimedShort(
  short: ClaimedShort,
  tickId: string,
  tickStartMs: number,
): Promise<TickOutcome> {
  const styleId = short.generation_progress?.style_id ?? short.style_id ?? null;
  const styleKey = styleKeyFor(styleId);
  if (!styleKey || !styleId) {
    // Not a pipeline style (or minimal) — shouldn't be queued. Clear it so
    // it never gets reclaimed in a loop.
    logger.warn('[shorts asset cron] claimed a non-pipeline short — clearing', {
      shortId: short.id,
      styleId,
    });
    await sql`
      UPDATE shorts
         SET generation_progress = '{}'::jsonb,
             generation_claimed_at = NULL,
             generation_claimed_by_tick = NULL
       WHERE id = ${short.id}::uuid AND workspace_id = ${short.workspace_id}::uuid
    `;
    return 'skipped';
  }

  const captions = captionsFor(short);
  if (captions.length === 0) {
    await finalizeError(short, styleId, short.style_assets ?? {}, 'Script could not be chunked into captions.');
    return 'error';
  }

  // Working copies, mutated as steps complete and flushed at each checkpoint.
  const assets: ShortStyleAssets = JSON.parse(JSON.stringify(short.style_assets ?? {}));
  let job: ShortsAssetJobState = { ...(short.generation_progress?.job ?? {}) };

  const block = () => assets[styleKey];

  // Terminal step: done if any variant landed (partial success by design),
  // else error with the most recent failure so the user knows why.
  const doFinalize = async (): Promise<TickOutcome> => {
    const doneCount = block()?.variants?.length ?? 0;
    if (doneCount > 0) {
      await finalizeDone(short, styleId, assets);
      logger.info('[shorts asset cron] finalized', {
        shortId: short.id,
        styleKey,
        variantCount: doneCount,
        costUsd: job.cost_usd ?? 0,
      });
      return 'done';
    }
    const lastErr = Object.values(job.variant_errors ?? {}).slice(-1)[0]
      ?? 'Every variant failed to generate.';
    await finalizeError(short, styleId, assets, `No variants could be generated. Last error: ${lastErr}`);
    logger.error('[shorts asset cron] finalized with zero variants', {
      shortId: short.id,
      styleKey,
      lastErr,
    });
    return 'error';
  };

  while (Date.now() - tickStartMs < TICK_BUDGET_MS) {
    const view: JobView = {
      job,
      baseUrl: block()?.base_url ?? null,
      doneIndexes: new Set((block()?.variants ?? []).map((v) => v.caption_chunk_start_index)),
    };
    const action = selectNextAction(view);

    if (action.kind === 'plan') {
      const planInput = {
        workspaceId: short.workspace_id,
        projectId: short.project_id,
        shortId: short.id,
        shortScript: short.short_script,
        hook: short.hook ?? undefined,
        payoff: short.payoff ?? undefined,
        title: short.title ?? undefined,
        niche: job.niche ?? 'general',
        captions,
        maxVariants: job.max_variants,
      };
      const planned = styleKey === 'paint'
        ? await planPaintAssets(planInput)
        : await planDoodleAssets(planInput);
      // Guard against a degenerate planner result. Without this, an empty
      // base_prompt or variant_plan would make selectNextAction return
      // 'plan' forever — an infinite re-plan loop burning LLM cost.
      if (!planned.basePrompt || planned.variantPlan.length === 0) {
        await finalizeError(
          short,
          styleId,
          assets,
          'The planner returned no usable base prompt or variants. Retry to re-plan.',
        );
        return 'error';
      }
      job = { ...job, base_prompt: planned.basePrompt, variant_plan: planned.variantPlan };
      await persistCheckpoint(short, tickId, {
        phase: 'base',
        label: `${styleKey === 'paint' ? 'Paint' : 'Doodle'} — generating base frame…`,
        total: planned.variantPlan.length,
        style_id: styleId,
        job,
      }, assets);
      continue;
    }

    if (action.kind === 'base') {
      const baseModelId = job.base_t2i_model_id ? resolveBaseT2iModelId(job.base_t2i_model_id) : undefined;
      const base = styleKey === 'paint'
        ? await generatePaintBaseFrame({ basePrompt: job.base_prompt!, baseT2iModelId: baseModelId, shortId: short.id })
        : await generateDoodleBaseFrame({ basePrompt: job.base_prompt!, baseT2iModelId: baseModelId, shortId: short.id });
      assets[styleKey] = {
        base_url: base.baseUrl,
        base_prompt: base.basePromptFull,
        variants: block()?.variants ?? [],
      };
      job = { ...job, cost_usd: (job.cost_usd ?? 0) + base.costUsd };
      await persistCheckpoint(short, tickId, {
        phase: 'variant',
        current: 0,
        total: job.variant_plan?.length ?? 0,
        label: variantLabel(styleKey, 0, job.variant_plan?.length ?? 0),
        style_id: styleId,
        job,
      }, assets);
      continue;
    }

    if (action.kind === 'variants') {
      const baseUrl = block()!.base_url;
      const total = job.variant_plan?.length ?? 0;
      // Attempt every currently-pending variant AT MOST once this tick, in
      // bounded-concurrency batches. A variant that fails is retried on a
      // LATER tick (≥1 min later), not hammered within this one — gentler on
      // a slow / rate-limited vendor, which is the failure mode that wedged
      // the old synchronous pipeline.
      for (let off = 0; off < action.pending.length; off += MAX_VARIANTS_PER_BATCH) {
        if (Date.now() - tickStartMs >= TICK_BUDGET_MS) break;
        const batch = action.pending.slice(off, off + MAX_VARIANTS_PER_BATCH);
        const results = await Promise.allSettled(
          batch.map((item: VariantPlanItem) =>
            styleKey === 'paint'
              ? generatePaintVariantFrame({ baseUrl, item, variantEditPrimary: job.variant_edit_primary, shortId: short.id })
              : generateDoodleVariantFrame({ baseUrl, item, variantEditPrimary: job.variant_edit_primary, shortId: short.id }),
          ),
        );

        const variant_attempts = { ...(job.variant_attempts ?? {}) };
        const variant_errors = { ...(job.variant_errors ?? {}) };
        let costAdded = 0;
        results.forEach((res, i) => {
          const item = batch[i];
          const key = String(item.caption_chunk_start_index);
          if (res.status === 'fulfilled') {
            const v: ShortFrameVariant = {
              url: res.value.url,
              caption_chunk_start_index: res.value.caption_chunk_start_index,
              edit_prompt: res.value.edit_prompt,
            };
            block()!.variants.push(v);
            costAdded += res.value.costUsd;
            delete variant_errors[key];
          } else {
            variant_attempts[key] = (variant_attempts[key] ?? 0) + 1;
            variant_errors[key] = sanitizeError(res.reason);
            logger.warn('[shorts asset cron] variant attempt failed', {
              shortId: short.id,
              styleKey,
              chunkIndex: item.caption_chunk_start_index,
              attempt: variant_attempts[key],
              detail: variant_errors[key],
            });
          }
        });

        job = {
          ...job,
          variant_attempts,
          variant_errors,
          cost_usd: (job.cost_usd ?? 0) + costAdded,
        };
        const doneCount = block()!.variants.length;
        await persistCheckpoint(short, tickId, {
          phase: 'variant',
          current: doneCount,
          total,
          label: variantLabel(styleKey, doneCount, total),
          style_id: styleId,
          job,
        }, assets);
      }

      // After this tick's single pass: if nothing remains to attempt (all
      // done or exhausted) finalize now; otherwise yield so the next tick
      // retries the still-pending variants.
      const after: JobView = {
        job,
        baseUrl: block()?.base_url ?? null,
        doneIndexes: new Set((block()?.variants ?? []).map((v) => v.caption_chunk_start_index)),
      };
      if (selectNextAction(after).kind === 'finalize') {
        return doFinalize();
      }
      if (Date.now() - tickStartMs >= TICK_BUDGET_MS) {
        // Out of time mid-variants — release so the NEXT tick resumes
        // promptly, and stop this tick (budget spent).
        await releaseClaim(short);
        logger.info('[shorts asset cron] yielded mid-variants (tick budget)', {
          shortId: short.id,
          styleKey,
          done: block()?.variants?.length ?? 0,
          total,
        });
        return 'yielded';
      }
      // Failed-but-retryable variants remain and we still have budget. Keep
      // the lease so this short ISN'T re-attempted within this tick (gentle
      // retry — a later tick picks it up once the lease lapses) while the
      // drain serves other queued shorts. Prevents one flaky short from
      // hammering the vendor or starving the queue.
      logger.info('[shorts asset cron] variants deferred for retry on a later tick', {
        shortId: short.id,
        styleKey,
        done: block()?.variants?.length ?? 0,
        total,
      });
      return 'deferred';
    }

    return doFinalize();
  }

  // Tick budget exhausted mid-job — release so the next tick resumes.
  await releaseClaim(short);
  logger.info('[shorts asset cron] yielded (tick budget)', { shortId: short.id, styleKey });
  return 'yielded';
}

export interface ShortsAssetDrainResult {
  claimed: number;
  done: number;
  errored: number;
  yielded: number;
  deferred: number;
  skipped: number;
}

/**
 * Claim + drive Shorts until the queue is empty or the tick budget is
 * spent. Each claimed Short is advanced as far as it can go this tick;
 * anything unfinished is left for the next tick (the lease guarantees it
 * gets picked back up — even if THIS function dies).
 */
export async function runShortsAssetDrain(tickId: string): Promise<ShortsAssetDrainResult> {
  const tickStartMs = Date.now();
  const result: ShortsAssetDrainResult = {
    claimed: 0, done: 0, errored: 0, yielded: 0, deferred: 0, skipped: 0,
  };

  while (Date.now() - tickStartMs < TICK_BUDGET_MS) {
    const short = await claimNextShort(tickId);
    if (!short) break;
    result.claimed++;
    let outcome: TickOutcome;
    try {
      outcome = await processClaimedShort(short, tickId, tickStartMs);
    } catch (err) {
      // Unhandled failure inside a step (DB blip, programming bug). Don't
      // let it strand the row claimed forever — release so a later tick
      // retries, and surface it.
      logger.error('[shorts asset cron] unhandled processing error', {
        shortId: short.id,
        detail: err instanceof Error ? err.message : String(err),
      });
      await releaseClaim(short).catch(() => {});
      outcome = 'yielded';
    }
    if (outcome === 'done') result.done++;
    else if (outcome === 'error') result.errored++;
    else if (outcome === 'yielded') result.yielded++;
    else if (outcome === 'deferred') result.deferred++;
    else result.skipped++;

    // A budget yield means this tick is out of time — stop. A 'deferred'
    // short keeps its lease (won't be re-claimed this tick), so we keep
    // draining other queued shorts.
    if (outcome === 'yielded') break;
  }

  return result;
}

// Monotonic-ish suffix so two triggers in the same millisecond get distinct
// tick ids. Process-local; only needs to be unique for log correlation.
let tickSeq = 0;

/**
 * Single-flight entry point used by BOTH the cron and the enqueue route's
 * fire-and-forget kick. They share the advisory lock, so concurrent triggers
 * (several auto-created Shorts firing at once, or a cron tick overlapping a
 * kick) never run two drains together — which is what would fan out
 * 3×N concurrent vendor calls and self-inflict the 429 storm we're trying to
 * avoid.
 *
 * Why both callers exist: Vercel crons run ONLY on production deployments, so
 * on preview / local deploys the enqueue kick is the only thing that drives
 * the work. In production the cron is the steady backstop that also heals
 * jobs whose kick died (lease reclaim).
 */
export async function triggerShortsAssetDrain(
  reason: string,
): Promise<CronLockOutcome<ShortsAssetDrainResult>> {
  const tickId = `sa_${reason}_${Date.now()}_${(tickSeq++).toString(36)}`;
  return withCronLock(CRON_LOCK_KEYS.shortsAssetRunner, () => runShortsAssetDrain(tickId));
}

/**
 * Advance ONE specific Short by a tick — the client-driven driver. The editor
 * calls this while a job is in flight, so generation progresses (and resumes
 * after a request death) even on preview / local deploys where the cron never
 * runs. Workspace-scoped so a user can only drive their own row. Shares the
 * single-flight lock with the cron + enqueue drain, so at most one runner
 * touches the vendors at a time.
 */
export async function runShortsAssetTickForShort(
  shortId: string,
  workspaceId: string,
): Promise<CronLockOutcome<{ claimed: boolean; outcome: TickOutcome | null }>> {
  const tickId = `sa_tick_${Date.now()}_${(tickSeq++).toString(36)}`;
  return withCronLock(CRON_LOCK_KEYS.shortsAssetRunner, async () => {
    const short = await claimSpecificShort(shortId, workspaceId, tickId);
    if (!short) return { claimed: false, outcome: null };
    const outcome = await processClaimedShort(short, tickId, Date.now());
    return { claimed: true, outcome };
  });
}

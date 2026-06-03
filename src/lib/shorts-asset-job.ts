/**
 * Shorts style-asset job — pure state machine (Phase 15.16).
 *
 * The background cron (`/api/cron/run-shorts-assets`) drives a claimed
 * Short through plan → base → variants → done by repeatedly asking this
 * helper "what's the next action?" given the durable job state
 * (`generation_progress.job`) plus what's already persisted on
 * `shorts.style_assets`. Keeping the decision pure means the whole state
 * machine is unit-testable without a DB, a cron, or vendor calls.
 *
 * Why a state machine and not a straight-line function: each tick does a
 * bounded amount of work and may stop early (time budget, vendor failure).
 * The NEXT tick has to pick up exactly where the last one left off. The
 * action is derived fresh each tick from persisted facts — never from
 * in-memory progress — so a tick that dies mid-work strands nothing.
 */

import type { ShortsAssetJobState } from './shorts-types';

/** Per-variant attempt cap. A variant that fails this many times across
 *  ticks is abandoned so a deterministically-failing edit (content policy,
 *  malformed prompt) can't loop forever or burn budget. The Short still
 *  finalizes with the variants that succeeded — partial success by design. */
export const MAX_VARIANT_ATTEMPTS = 3;

export type VariantPlanItem = { caption_chunk_start_index: number; edit_prompt: string };

/** The next bounded step the cron should take for a claimed Short. */
export type ShortsAssetAction =
  | { kind: 'plan' }
  | { kind: 'base' }
  | { kind: 'variants'; pending: VariantPlanItem[] }
  | { kind: 'finalize' };

export interface JobView {
  /** Durable job state carried in `generation_progress.job`. */
  job: ShortsAssetJobState | undefined | null;
  /** Base frame URL already persisted on `style_assets`, if any. */
  baseUrl: string | null | undefined;
  /** caption_chunk_start_index values already persisted as variants. */
  doneIndexes: ReadonlySet<number>;
}

/** True once a variant has used up its attempt budget. */
export function isVariantExhausted(
  job: ShortsAssetJobState | undefined | null,
  captionChunkStartIndex: number,
): boolean {
  const attempts = job?.variant_attempts?.[String(captionChunkStartIndex)] ?? 0;
  return attempts >= MAX_VARIANT_ATTEMPTS;
}

/** Variants still worth attempting this tick: planned, not yet persisted,
 *  and not past the attempt cap. */
export function pendingVariants(view: JobView): VariantPlanItem[] {
  const plan = view.job?.variant_plan;
  if (!plan || plan.length === 0) return [];
  return plan.filter((v) => {
    if (view.doneIndexes.has(v.caption_chunk_start_index)) return false;
    return !isVariantExhausted(view.job, v.caption_chunk_start_index);
  });
}

/**
 * Decide the next action from persisted facts only. Order: plan first
 * (need prompts), then base (variants edit the base), then any pending
 * variants, then finalize. Finalize means "no more work is worth doing" —
 * the caller inspects how many variants actually landed to choose the
 * terminal phase (done vs error).
 */
export function selectNextAction(view: JobView): ShortsAssetAction {
  const job = view.job;
  if (!job?.variant_plan || job.variant_plan.length === 0 || !job.base_prompt) {
    return { kind: 'plan' };
  }
  if (!view.baseUrl) {
    return { kind: 'base' };
  }
  const pending = pendingVariants(view);
  if (pending.length > 0) {
    return { kind: 'variants', pending };
  }
  return { kind: 'finalize' };
}

/** How many planned variants are not yet done (whether retryable or
 *  exhausted). Drives the "variant X of N" label. */
export function remainingVariantCount(view: JobView): number {
  const plan = view.job?.variant_plan;
  if (!plan) return 0;
  return plan.filter((v) => !view.doneIndexes.has(v.caption_chunk_start_index)).length;
}

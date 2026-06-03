import { describe, expect, it } from 'vitest';
import {
  MAX_VARIANT_ATTEMPTS,
  isVariantExhausted,
  pendingVariants,
  remainingVariantCount,
  selectNextAction,
  type JobView,
} from '@/lib/shorts-asset-job';
import type { ShortsAssetJobState } from '@/lib/shorts-types';

const PLAN = [
  { caption_chunk_start_index: 0, edit_prompt: 'p0' },
  { caption_chunk_start_index: 2, edit_prompt: 'p2' },
  { caption_chunk_start_index: 4, edit_prompt: 'p4' },
];

function view(job: ShortsAssetJobState | null, baseUrl: string | null, done: number[]): JobView {
  return { job, baseUrl, doneIndexes: new Set(done) };
}

describe('selectNextAction', () => {
  it('plans when there is no job state at all', () => {
    expect(selectNextAction(view(null, null, []))).toEqual({ kind: 'plan' });
  });

  it('plans when the plan exists but base_prompt is missing', () => {
    expect(
      selectNextAction(view({ variant_plan: PLAN }, null, [])),
    ).toEqual({ kind: 'plan' });
  });

  it('plans when base_prompt exists but the variant plan is empty', () => {
    expect(
      selectNextAction(view({ base_prompt: 'b', variant_plan: [] }, null, [])),
    ).toEqual({ kind: 'plan' });
  });

  it('generates the base once planned but no base url yet', () => {
    expect(
      selectNextAction(view({ base_prompt: 'b', variant_plan: PLAN }, null, [])),
    ).toEqual({ kind: 'base' });
  });

  it('returns all variants as pending right after the base lands', () => {
    const action = selectNextAction(view({ base_prompt: 'b', variant_plan: PLAN }, 'base.png', []));
    expect(action.kind).toBe('variants');
    if (action.kind === 'variants') {
      expect(action.pending.map((v) => v.caption_chunk_start_index)).toEqual([0, 2, 4]);
    }
  });

  it('only returns not-yet-done variants as pending', () => {
    const action = selectNextAction(view({ base_prompt: 'b', variant_plan: PLAN }, 'base.png', [0, 4]));
    expect(action.kind).toBe('variants');
    if (action.kind === 'variants') {
      expect(action.pending.map((v) => v.caption_chunk_start_index)).toEqual([2]);
    }
  });

  it('skips variants that have exhausted their attempt budget', () => {
    const job: ShortsAssetJobState = {
      base_prompt: 'b',
      variant_plan: PLAN,
      variant_attempts: { '2': MAX_VARIANT_ATTEMPTS },
    };
    const action = selectNextAction(view(job, 'base.png', [0]));
    expect(action.kind).toBe('variants');
    if (action.kind === 'variants') {
      // index 0 done, index 2 exhausted → only index 4 left
      expect(action.pending.map((v) => v.caption_chunk_start_index)).toEqual([4]);
    }
  });

  it('finalizes when every variant is either done or exhausted', () => {
    const job: ShortsAssetJobState = {
      base_prompt: 'b',
      variant_plan: PLAN,
      variant_attempts: { '4': MAX_VARIANT_ATTEMPTS },
    };
    // 0 and 2 done, 4 exhausted → nothing left to attempt
    expect(selectNextAction(view(job, 'base.png', [0, 2]))).toEqual({ kind: 'finalize' });
  });

  it('finalizes when all variants are done', () => {
    expect(
      selectNextAction(view({ base_prompt: 'b', variant_plan: PLAN }, 'base.png', [0, 2, 4])),
    ).toEqual({ kind: 'finalize' });
  });
});

describe('isVariantExhausted', () => {
  it('is false below the cap and true at/above it', () => {
    expect(isVariantExhausted({ variant_attempts: { '0': MAX_VARIANT_ATTEMPTS - 1 } }, 0)).toBe(false);
    expect(isVariantExhausted({ variant_attempts: { '0': MAX_VARIANT_ATTEMPTS } }, 0)).toBe(true);
    expect(isVariantExhausted({ variant_attempts: { '0': MAX_VARIANT_ATTEMPTS + 2 } }, 0)).toBe(true);
  });

  it('treats a missing attempt count as zero', () => {
    expect(isVariantExhausted(null, 7)).toBe(false);
    expect(isVariantExhausted({}, 7)).toBe(false);
  });
});

describe('pendingVariants / remainingVariantCount', () => {
  it('pendingVariants excludes done + exhausted', () => {
    const job: ShortsAssetJobState = {
      base_prompt: 'b',
      variant_plan: PLAN,
      variant_attempts: { '0': MAX_VARIANT_ATTEMPTS },
    };
    expect(pendingVariants(view(job, 'base.png', [2])).map((v) => v.caption_chunk_start_index)).toEqual([4]);
  });

  it('remainingVariantCount counts not-done regardless of exhaustion', () => {
    const job: ShortsAssetJobState = {
      base_prompt: 'b',
      variant_plan: PLAN,
      variant_attempts: { '0': MAX_VARIANT_ATTEMPTS },
    };
    // index 0 exhausted but still "not done" → counts; index 2 done → not counted
    expect(remainingVariantCount(view(job, 'base.png', [2]))).toBe(2);
  });

  it('pendingVariants is empty when there is no plan', () => {
    expect(pendingVariants(view(null, null, []))).toEqual([]);
  });
});

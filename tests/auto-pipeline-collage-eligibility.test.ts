import { describe, expect, it } from 'vitest';
import {
  isCollageEligibleRow,
  type PipelineImageDoc,
  type PipelineImageRow,
} from '@/lib/auto-pipeline/production-doc-image-gen';

// ─── isCollageEligibleRow ─────────────────────────────────────────────────
//
// Plan: _plans/2026-05-28-auto-pipeline-collage-port.md.
//
// The eligibility filter decides whether a base row can flow through the
// 4-up collage path or must stay single-shot. Wrong exclusions silently
// regress identity preservation (character_id / scene_id cache bypass) or
// style consistency (style-ref drop). Wrong inclusions cost cycles and
// can produce mis-rendered cells. This file owns the contract.

const EMPTY_DOC: PipelineImageDoc = { rows: [] };

function baseRow(overrides: Partial<PipelineImageRow> = {}): PipelineImageRow {
  return {
    ai_image_prompt: 'A wide shot of a doodle scene',
    variant_index: 0,
    ...overrides,
  };
}

describe('isCollageEligibleRow — happy path', () => {
  it('admits a plain base row with prompt + no anchors + no refs', () => {
    const verdict = isCollageEligibleRow(baseRow(), EMPTY_DOC, false);
    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  it('admits a base row that has character_id but the cache is empty', () => {
    // Character_id alone is not disqualifying — only character_id WITH a
    // populated cache entry is. The row will be the first occurrence and
    // populate the cache after generation.
    const verdict = isCollageEligibleRow(
      baseRow({ character_id: 'george' }),
      { rows: [], doodle_explainer_2_character_cache: {} },
      false,
    );
    expect(verdict.eligible).toBe(true);
  });

  it('admits a base row whose cache entry has no base_url (defensive)', () => {
    // An empty entry shouldn't trigger the cache-hit exclusion. The
    // continuation path needs base_url to fire — without it the row falls
    // through to fresh i2i anyway.
    const verdict = isCollageEligibleRow(
      baseRow({ character_id: 'george' }),
      {
        rows: [],
        doodle_explainer_2_character_cache: {
          george: { base_url: '', first_seen_row_index: 0 },
        },
      },
      false,
    );
    expect(verdict.eligible).toBe(true);
  });
});

describe('isCollageEligibleRow — variant exclusion', () => {
  it('excludes variant_index > 0', () => {
    const verdict = isCollageEligibleRow(
      baseRow({ variant_index: 1, group_id: 'g1' }),
      EMPTY_DOC,
      false,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('variant');
  });

  it('treats variant_index undefined as 0 (base)', () => {
    const verdict = isCollageEligibleRow(
      baseRow({ variant_index: undefined }),
      EMPTY_DOC,
      false,
    );
    expect(verdict.eligible).toBe(true);
  });
});

describe('isCollageEligibleRow — cache-hit exclusions', () => {
  it('excludes when character_id has a cache hit with populated base_url', () => {
    const verdict = isCollageEligibleRow(
      baseRow({ character_id: 'george' }),
      {
        rows: [],
        doodle_explainer_2_character_cache: {
          george: { base_url: 'https://r2/george-base.png', first_seen_row_index: 3 },
        },
      },
      false,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('character_cache');
  });

  it('excludes when scene_id has a cache hit with populated base_url', () => {
    const verdict = isCollageEligibleRow(
      baseRow({ scene_id: 'sodder-house' }),
      {
        rows: [],
        doodle_explainer_2_scene_cache: {
          'sodder-house': { base_url: 'https://r2/sodder-house.png', first_seen_row_index: 1 },
        },
      },
      false,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('scene_cache');
  });

  it('character cache takes precedence over scene cache when both hit', () => {
    // Both anchors set, both cached. The character branch checks first.
    // Either reason would be correct for the contract (row is ineligible
    // for collage), but documenting the precedence so a future
    // implementation change is intentional, not accidental.
    const verdict = isCollageEligibleRow(
      baseRow({ character_id: 'george', scene_id: 'sodder-house' }),
      {
        rows: [],
        doodle_explainer_2_character_cache: {
          george: { base_url: 'https://r2/g.png', first_seen_row_index: 0 },
        },
        doodle_explainer_2_scene_cache: {
          'sodder-house': { base_url: 'https://r2/s.png', first_seen_row_index: 0 },
        },
      },
      false,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('character_cache');
  });
});

describe('isCollageEligibleRow — paint_explainer_v1 exclusions', () => {
  it('excludes rows with non-empty motion_beats', () => {
    // motion_beats means the row is a paint_explainer_v1 character shot
    // whose base must be a single coherent frame the variants can edit
    // from. A sliced collage quadrant would not align with the variant
    // chain that derives from it.
    const verdict = isCollageEligibleRow(
      baseRow({ motion_beats: [{ kind: 'mouth_swap' }] }),
      EMPTY_DOC,
      false,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('motion_beats');
  });

  it('excludes rows with a populated mouth_removed_url', () => {
    // The <MouthSwap> overlay requires pixel-perfect alignment with the
    // base. A sliced collage quadrant would re-compose the pixels and
    // shift the mouth anchor by sub-pixel amounts.
    const verdict = isCollageEligibleRow(
      baseRow({ mouth_removed_url: 'https://r2/mouth-removed.png' }),
      EMPTY_DOC,
      false,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('mouth_removed');
  });

  it('admits rows with empty motion_beats array (paint cutaway without face animation)', () => {
    // Empty arrays don't trigger the exclusion — they're treated the
    // same as no motion_beats field.
    const verdict = isCollageEligibleRow(
      baseRow({ motion_beats: [] }),
      EMPTY_DOC,
      false,
    );
    expect(verdict.eligible).toBe(true);
  });
});

describe('isCollageEligibleRow — style refs exclusion', () => {
  it('excludes when the doc has loaded style refs (i2i path required)', () => {
    // styleHasRefs is computed once per tick by the stage handler via
    // resolveStyle + loadStyleReferences. If refs are present, every
    // base row must go through i2i with the refs attached — the collage
    // route is t2i-only and would silently drop them.
    const verdict = isCollageEligibleRow(baseRow(), EMPTY_DOC, true);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('style_refs');
  });
});

describe('isCollageEligibleRow — defensive checks', () => {
  it('rejects an empty ai_image_prompt', () => {
    const verdict = isCollageEligibleRow(
      baseRow({ ai_image_prompt: '' }),
      EMPTY_DOC,
      false,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('no_prompt');
  });

  it('rejects an ai_image_prompt of only whitespace', () => {
    const verdict = isCollageEligibleRow(
      baseRow({ ai_image_prompt: '   \n\t  ' }),
      EMPTY_DOC,
      false,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('no_prompt');
  });
});

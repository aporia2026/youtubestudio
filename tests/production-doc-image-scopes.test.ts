import { describe, it, expect } from 'vitest';
import {
  IMAGE_SCOPE_KINDS,
  type ImageScopeKind,
  getRowsMatchingScope,
  getAllScopeCounts,
  scopeOverwritesExistingImages,
  scopeLabel,
} from '@/lib/production-doc-image-scopes';
import type { ProductionRow } from '@/remotion/utils';
import type { RowImageStateView } from '@/components/production-doc/editor/types';

function row(over: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '0:00',
    visual_type: 'Animation',
    visual_description: 'desc',
    script_text: 'script',
    ...over,
  } as ProductionRow;
}

function state(over: Partial<RowImageStateView> = {}): RowImageStateView {
  return {
    status: 'idle',
    ...over,
  } as RowImageStateView;
}

describe('getRowsMatchingScope', () => {
  it('empty scope: undefined state, idle status, and missing imageUrl all match', () => {
    const rows = [row(), row(), row(), row()];
    const images: ReadonlyArray<RowImageStateView | undefined> = [
      undefined,
      state({ status: 'idle' }),
      state({ status: 'done', imageUrl: 'https://x/img.png' }),
      state({ status: 'loading' }),
    ];
    expect(getRowsMatchingScope(rows, images, 'empty')).toEqual([0, 1]);
  });

  it('failed scope: only status === error rows match', () => {
    const rows = [row(), row(), row(), row()];
    const images = [
      state({ status: 'error' }),
      state({ status: 'done', imageUrl: 'https://x/img.png' }),
      state({ status: 'error' }),
      state({ status: 'idle' }),
    ];
    expect(getRowsMatchingScope(rows, images, 'failed')).toEqual([0, 2]);
  });

  it('animation scope: excludes motion_collage AND Title Card rows', () => {
    const rows = [
      row({ visual_type: 'Animation' }),
      row({ visual_type: 'Title Card' }),
      row({ shot_kind: 'motion_collage' }),
      row({ visual_type: 'Animation' }),
    ];
    expect(getRowsMatchingScope(rows, [], 'animation')).toEqual([0, 3]);
  });

  it('motion_collage scope: only shot_kind === motion_collage matches', () => {
    const rows = [
      row({ shot_kind: 'motion_collage' }),
      row(),
      row({ shot_kind: 'motion_collage' }),
    ];
    expect(getRowsMatchingScope(rows, [], 'motion_collage')).toEqual([0, 2]);
  });

  it('base_variant scope: variant_index undefined or 0 matches', () => {
    const rows = [
      row(),
      row({ variant_index: 0 }),
      row({ variant_index: 1 }),
      row({ variant_index: 2 }),
      row({ variant_index: 0 }),
    ];
    expect(getRowsMatchingScope(rows, [], 'base_variant')).toEqual([0, 1, 4]);
  });

  it('non_base_variant scope: variant_index > 0 matches', () => {
    const rows = [
      row(),
      row({ variant_index: 0 }),
      row({ variant_index: 1 }),
      row({ variant_index: 2 }),
    ];
    expect(getRowsMatchingScope(rows, [], 'non_base_variant')).toEqual([2, 3]);
  });

  it('title_card scope: only visual_type === Title Card matches', () => {
    const rows = [
      row({ visual_type: 'Title Card' }),
      row({ visual_type: 'Animation' }),
      row({ visual_type: 'Title Card' }),
    ];
    expect(getRowsMatchingScope(rows, [], 'title_card')).toEqual([0, 2]);
  });

  it('all scope: every row matches in ascending order', () => {
    const rows = [row(), row(), row()];
    expect(getRowsMatchingScope(rows, [], 'all')).toEqual([0, 1, 2]);
  });

  it('empty doc: every scope returns empty array', () => {
    for (const scope of IMAGE_SCOPE_KINDS) {
      expect(getRowsMatchingScope([], [], scope)).toEqual([]);
    }
  });

  it('returns indices in ascending order even when matches are sparse', () => {
    const rows = [
      row({ visual_type: 'Title Card' }),
      row({ visual_type: 'Animation' }),
      row({ visual_type: 'Animation' }),
      row({ visual_type: 'Title Card' }),
    ];
    expect(getRowsMatchingScope(rows, [], 'title_card')).toEqual([0, 3]);
    expect(getRowsMatchingScope(rows, [], 'animation')).toEqual([1, 2]);
  });
});

describe('getAllScopeCounts', () => {
  it('counts each kind in a single pass', () => {
    const rows = [
      row({ visual_type: 'Title Card' }),                              // title_card, base
      row({ visual_type: 'Animation', variant_index: 0 }),             // animation, base
      row({ visual_type: 'Animation', variant_index: 1 }),             // animation, non-base
      row({ shot_kind: 'motion_collage', variant_index: 0 }),          // motion_collage, base
      row({ visual_type: 'Animation' }),                               // animation, base
    ];
    const images = [
      state({ status: 'done', imageUrl: 'x' }),
      undefined,
      state({ status: 'error' }),
      state({ status: 'idle' }),
      state({ status: 'loading' }),
    ];
    const counts = getAllScopeCounts(rows, images);
    expect(counts.empty).toBe(2);              // rows 1 + 3
    expect(counts.failed).toBe(1);             // row 2
    expect(counts.animation).toBe(3);          // rows 1, 2, 4
    expect(counts.motion_collage).toBe(1);     // row 3
    expect(counts.base_variant).toBe(4);       // rows 0, 1, 3, 4
    expect(counts.non_base_variant).toBe(1);   // row 2
    expect(counts.title_card).toBe(1);         // row 0
    expect(counts.all).toBe(5);
  });

  it('empty doc returns all zeros', () => {
    const counts = getAllScopeCounts([], []);
    for (const k of IMAGE_SCOPE_KINDS) expect(counts[k]).toBe(0);
  });

  it('matches getRowsMatchingScope.length for every kind', () => {
    const rows = [
      row({ visual_type: 'Title Card' }),
      row({ shot_kind: 'motion_collage' }),
      row({ variant_index: 1 }),
      row(),
    ];
    const images = [state({ status: 'error' }), undefined, state({ status: 'done', imageUrl: 'x' }), state({ status: 'idle' })];
    const counts = getAllScopeCounts(rows, images);
    for (const k of IMAGE_SCOPE_KINDS) {
      expect(counts[k]).toBe(getRowsMatchingScope(rows, images, k).length);
    }
  });
});

describe('scopeOverwritesExistingImages', () => {
  it('empty and failed are non-destructive', () => {
    expect(scopeOverwritesExistingImages('empty')).toBe(false);
    expect(scopeOverwritesExistingImages('failed')).toBe(false);
  });

  it('every other scope is destructive', () => {
    const destructive: ImageScopeKind[] = [
      'animation', 'motion_collage', 'base_variant',
      'non_base_variant', 'title_card', 'all',
    ];
    for (const s of destructive) expect(scopeOverwritesExistingImages(s)).toBe(true);
  });
});

describe('scopeLabel', () => {
  it('returns a non-empty string for every kind', () => {
    for (const k of IMAGE_SCOPE_KINDS) {
      const label = scopeLabel(k);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('all-scope label flags destructive intent', () => {
    expect(scopeLabel('all')).toMatch(/ALL/);
  });
});

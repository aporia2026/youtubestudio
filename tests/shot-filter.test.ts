/**
 * Tests for the editor SHOTS-rail filter helpers.
 *
 * Covers:
 *   - rowKind precedence (shot_kind beats visual_type, fallback to anim)
 *   - rowGrouping (base requires groupSize > 1, variant from variant_index)
 *   - passes predicate (empty axes pass everything, both-axis AND)
 *   - computeCounts (per-kind + per-grouping)
 *   - toggleKind / toggleGrouping (immutable, sorted)
 *   - serializeFilter / parseFilter round-trip + garbage-input safety
 *
 * Plan: `_plans/2026-06-02-editor-shot-type-filter.md`.
 */
import { describe, expect, it } from 'vitest';
import {
  rowKind,
  rowGrouping,
  passes,
  computeCounts,
  isEmptyFilter,
  toggleKind,
  toggleGrouping,
  serializeFilter,
  parseFilter,
  filterStorageKey,
  EMPTY_FILTER,
  type ShotFilter,
} from '@/lib/shot-filter';

describe('rowKind', () => {
  it('classifies motion_collage as collage regardless of visual_type', () => {
    // shot_kind wins — this is the "Title Card row that's actually a
    // motion collage" case the plan calls out.
    expect(rowKind({ shot_kind: 'motion_collage', visual_type: 'Title Card' })).toBe('collage');
    expect(rowKind({ shot_kind: 'motion_collage', visual_type: 'Animation' })).toBe('collage');
  });

  it('classifies motion as motion', () => {
    expect(rowKind({ shot_kind: 'motion', visual_type: 'Animation' })).toBe('motion');
  });

  it('classifies Title Card as title when shot_kind is not motion-y', () => {
    expect(rowKind({ visual_type: 'Title Card' })).toBe('title');
    expect(rowKind({ shot_kind: 'static', visual_type: 'Title Card' })).toBe('title');
  });

  it('classifies Statistics / B-Roll / blank', () => {
    expect(rowKind({ visual_type: 'Statistics' })).toBe('stat');
    expect(rowKind({ visual_type: 'B-Roll' })).toBe('broll');
    expect(rowKind({ visual_type: 'blank' })).toBe('blank');
  });

  it('falls back to anim for Animation and unknown visual_types', () => {
    expect(rowKind({ visual_type: 'Animation' })).toBe('anim');
    expect(rowKind({ visual_type: 'something-weird' })).toBe('anim');
    expect(rowKind({})).toBe('anim');
  });
});

describe('rowGrouping', () => {
  it('returns null for ungrouped rows', () => {
    expect(rowGrouping({ variant_index: 0 }, 0)).toBeNull();
    expect(rowGrouping({ group_id: undefined, variant_index: 5 }, 3)).toBeNull();
  });

  it('returns null for a "group" of one (base alone doesnt deserve a chip)', () => {
    expect(rowGrouping({ group_id: 'g1', variant_index: 0 }, 1)).toBeNull();
  });

  it('returns base for variant_index 0 in a group of 2+', () => {
    expect(rowGrouping({ group_id: 'g1', variant_index: 0 }, 2)).toBe('base');
    expect(rowGrouping({ group_id: 'g1' }, 3)).toBe('base'); // missing variant_index defaults to 0
  });

  it('returns variant for variant_index > 0', () => {
    expect(rowGrouping({ group_id: 'g1', variant_index: 1 }, 2)).toBe('variant');
    expect(rowGrouping({ group_id: 'g1', variant_index: 5 }, 6)).toBe('variant');
  });
});

describe('passes predicate', () => {
  const titleRow = { visual_type: 'Title Card' as const };
  const collageRow = { shot_kind: 'motion_collage' as const, visual_type: 'Animation' };
  const animRow = { visual_type: 'Animation' };

  it('empty filter passes everything', () => {
    expect(passes(titleRow, 0, EMPTY_FILTER)).toBe(true);
    expect(passes(collageRow, 0, EMPTY_FILTER)).toBe(true);
    expect(passes(animRow, 0, EMPTY_FILTER)).toBe(true);
  });

  it('kind-only filter constrains to matching kinds', () => {
    const f: ShotFilter = { kinds: ['title', 'collage'], grouping: [] };
    expect(passes(titleRow, 0, f)).toBe(true);
    expect(passes(collageRow, 0, f)).toBe(true);
    expect(passes(animRow, 0, f)).toBe(false);
  });

  it('grouping-only filter constrains to matching grouping', () => {
    const f: ShotFilter = { kinds: [], grouping: ['variant'] };
    expect(passes({ ...animRow, group_id: 'g1', variant_index: 1 }, 2, f)).toBe(true);
    expect(passes({ ...animRow, group_id: 'g1', variant_index: 0 }, 2, f)).toBe(false); // base, not variant
    expect(passes(animRow, 0, f)).toBe(false); // ungrouped
  });

  it('both-axis filter requires AND across', () => {
    const f: ShotFilter = { kinds: ['anim'], grouping: ['variant'] };
    // anim + variant → passes
    expect(passes({ ...animRow, group_id: 'g1', variant_index: 1 }, 2, f)).toBe(true);
    // title + variant → fails kind axis
    expect(passes({ ...titleRow, group_id: 'g1', variant_index: 1 }, 2, f)).toBe(false);
    // anim + base → fails grouping axis
    expect(passes({ ...animRow, group_id: 'g1', variant_index: 0 }, 2, f)).toBe(false);
  });
});

describe('computeCounts', () => {
  it('totals per-kind and per-grouping in one pass', () => {
    const rows = [
      { visual_type: 'Title Card' },
      { shot_kind: 'motion_collage' as const, visual_type: 'Animation' },
      { visual_type: 'Animation' },
      { visual_type: 'Animation', group_id: 'g1', variant_index: 0 },
      { visual_type: 'Animation', group_id: 'g1', variant_index: 1 },
      { visual_type: 'Animation', group_id: 'g1', variant_index: 2 },
    ];
    const counts = computeCounts(rows);
    expect(counts.total).toBe(6);
    expect(counts.byKind.title).toBe(1);
    expect(counts.byKind.collage).toBe(1);
    expect(counts.byKind.anim).toBe(4);
    expect(counts.byKind.blank).toBe(0);
    expect(counts.byGrouping.base).toBe(1);
    expect(counts.byGrouping.variant).toBe(2);
  });

  it('zero rows → zero counts (no division-by-zero)', () => {
    const counts = computeCounts([]);
    expect(counts.total).toBe(0);
    expect(counts.byKind.anim).toBe(0);
    expect(counts.byGrouping.base).toBe(0);
  });
});

describe('isEmptyFilter', () => {
  it('returns true for EMPTY_FILTER', () => {
    expect(isEmptyFilter(EMPTY_FILTER)).toBe(true);
  });
  it('returns false when any axis is populated', () => {
    expect(isEmptyFilter({ kinds: ['title'], grouping: [] })).toBe(false);
    expect(isEmptyFilter({ kinds: [], grouping: ['base'] })).toBe(false);
  });
});

describe('toggleKind / toggleGrouping', () => {
  it('adds a kind when absent', () => {
    const r = toggleKind(EMPTY_FILTER, 'title');
    expect(r.kinds).toEqual(['title']);
    expect(r.grouping).toEqual([]); // other axis untouched
  });

  it('removes a kind when present', () => {
    const r = toggleKind({ kinds: ['title', 'collage'], grouping: [] }, 'title');
    expect(r.kinds).toEqual(['collage']);
  });

  it('keeps kinds sorted so serialization is canonical', () => {
    const r = toggleKind({ kinds: ['title'], grouping: [] }, 'collage');
    expect(r.kinds).toEqual(['collage', 'title']);
  });

  it('same shape for grouping toggles', () => {
    const r = toggleGrouping({ kinds: [], grouping: ['variant'] }, 'base');
    expect(r.grouping).toEqual(['base', 'variant']);
  });
});

describe('serializeFilter / parseFilter', () => {
  it('round-trips a populated filter', () => {
    const f: ShotFilter = { kinds: ['title', 'collage'], grouping: ['variant'] };
    const round = parseFilter(serializeFilter(f));
    // sorted invariant
    expect(round).toEqual({ kinds: ['collage', 'title'], grouping: ['variant'] });
  });

  it('round-trips an empty filter', () => {
    expect(parseFilter(serializeFilter(EMPTY_FILTER))).toEqual(EMPTY_FILTER);
  });

  it('returns EMPTY_FILTER for null / undefined / empty string', () => {
    expect(parseFilter(null)).toEqual(EMPTY_FILTER);
    expect(parseFilter(undefined)).toEqual(EMPTY_FILTER);
    expect(parseFilter('')).toEqual(EMPTY_FILTER);
  });

  it('survives garbage JSON', () => {
    expect(parseFilter('not-json')).toEqual(EMPTY_FILTER);
    expect(parseFilter('{')).toEqual(EMPTY_FILTER);
  });

  it('survives wrong-shape JSON', () => {
    expect(parseFilter('42')).toEqual(EMPTY_FILTER);
    expect(parseFilter('null')).toEqual(EMPTY_FILTER);
    expect(parseFilter('"a string"')).toEqual(EMPTY_FILTER);
    expect(parseFilter('[]')).toEqual(EMPTY_FILTER);
  });

  it('silently drops unknown kinds (forward-compat with older saves)', () => {
    const raw = JSON.stringify({ kinds: ['title', 'somethingNew', 'collage'], grouping: ['xyz', 'base'] });
    expect(parseFilter(raw)).toEqual({ kinds: ['collage', 'title'], grouping: ['base'] });
  });

  it('dedupes repeated entries', () => {
    const raw = JSON.stringify({ kinds: ['title', 'title'], grouping: ['base', 'base'] });
    expect(parseFilter(raw)).toEqual({ kinds: ['title'], grouping: ['base'] });
  });
});

describe('filterStorageKey', () => {
  it('is keyed per project', () => {
    expect(filterStorageKey('abc')).toBe('editor:shot-filter:abc');
    expect(filterStorageKey('xyz')).toBe('editor:shot-filter:xyz');
    expect(filterStorageKey('abc')).not.toBe(filterStorageKey('xyz'));
  });
});

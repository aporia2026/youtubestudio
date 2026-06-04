/**
 * Unit tests for the reorder helper used by the SceneStrip drag-to-
 * reorder feature. The helper is the single source of truth for how
 * a row reorder cascades through every row-indexed state slice; if
 * one slice drifts the inspector shows the wrong image / video /
 * overlay for the wrong row. This suite pins the contracts.
 */

import { describe, expect, it } from 'vitest';
import {
  deleteFromArray,
  deleteFromRecord,
  deleteIndexMap,
  deleteRowFromProductionDocState,
  deleteSingleIndex,
  reorderArray,
  reorderIndexMap,
  reorderProductionDocState,
  reorderRecord,
  reorderSingleIndex,
} from '@/lib/production-doc-reorder';
import type { ProductionRow } from '@/remotion/utils';

function makeRow(label: string): ProductionRow {
  return {
    timecode: '0:00',
    script_text: label,
    visual_type: 'B-Roll',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
  } as ProductionRow;
}

describe('reorderIndexMap', () => {
  it('is identity when from === to', () => {
    const map = reorderIndexMap(2, 2, 5);
    for (let i = 0; i < 5; i++) {
      expect(map[i]).toBe(i);
    }
  });

  it('moving forward (from < to) shifts the moved index to `to` and shifts the gap back by one', () => {
    // length 5; move index 1 → 3
    //   before: 0 1 2 3 4
    //   after:  0 2 3 1 4
    const map = reorderIndexMap(1, 3, 5);
    expect(map[0]).toBe(0);
    expect(map[1]).toBe(3);
    expect(map[2]).toBe(1);
    expect(map[3]).toBe(2);
    expect(map[4]).toBe(4);
  });

  it('moving backward (from > to) shifts the moved index to `to` and shifts the gap forward by one', () => {
    // length 5; move index 4 → 1
    //   before: 0 1 2 3 4
    //   after:  0 4 1 2 3
    const map = reorderIndexMap(4, 1, 5);
    expect(map[0]).toBe(0);
    expect(map[1]).toBe(2);
    expect(map[2]).toBe(3);
    expect(map[3]).toBe(4);
    expect(map[4]).toBe(1);
  });

  it('matches the array reorder result element-by-element (forward move)', () => {
    const before = ['a', 'b', 'c', 'd', 'e'];
    const after = reorderArray(before, 1, 3);
    const map = reorderIndexMap(1, 3, before.length);
    for (let i = 0; i < before.length; i++) {
      const newIdx = map[i];
      expect(after[newIdx]).toBe(before[i]);
    }
  });

  it('matches the array reorder result element-by-element (backward move)', () => {
    const before = ['a', 'b', 'c', 'd', 'e'];
    const after = reorderArray(before, 4, 1);
    const map = reorderIndexMap(4, 1, before.length);
    for (let i = 0; i < before.length; i++) {
      const newIdx = map[i];
      expect(after[newIdx]).toBe(before[i]);
    }
  });
});

describe('reorderArray', () => {
  it('moves the element forward (from < to)', () => {
    expect(reorderArray(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves the element backward (from > to)', () => {
    expect(reorderArray(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when from === to', () => {
    expect(reorderArray(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('returns a copy when indexes are out of range (no crash)', () => {
    expect(reorderArray(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
    expect(reorderArray(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c'];
    reorderArray(input, 0, 2);
    expect(input).toEqual(['a', 'b', 'c']);
  });
});

describe('reorderRecord', () => {
  it('rekeys every value to match a forward array reorder', () => {
    // length 4; move 0 → 2. After: index 0=b, 1=c, 2=a, 3=d.
    // So a record {0:'A', 1:'B', 2:'C', 3:'D'} where the values
    // "follow" the items should become {0:'B', 1:'C', 2:'A', 3:'D'}.
    const result = reorderRecord({ 0: 'A', 1: 'B', 2: 'C', 3: 'D' }, 0, 2, 4);
    expect(result).toEqual({ 0: 'B', 1: 'C', 2: 'A', 3: 'D' });
  });

  it('rekeys every value to match a backward array reorder', () => {
    // length 4; move 3 → 1. After: a, d, b, c.
    const result = reorderRecord({ 0: 'A', 1: 'B', 2: 'C', 3: 'D' }, 3, 1, 4);
    expect(result).toEqual({ 0: 'A', 1: 'D', 2: 'B', 3: 'C' });
  });

  it('omits values whose keys are absent (no synthetic defaults)', () => {
    // Only some rows have a value. The moved/shifted keys preserve
    // their assignment relationship.
    const result = reorderRecord({ 0: 'A', 3: 'D' }, 0, 3, 4);
    // 0 → 3 (moved), 3 → 2 (shifted back).
    expect(result).toEqual({ 3: 'A', 2: 'D' });
  });

  it('is a copy (not the same reference) when from === to', () => {
    const input = { 0: 'A', 1: 'B' };
    const out = reorderRecord(input, 1, 1, 2);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('preserves out-of-range keys instead of dropping them (defensive)', () => {
    // QA hardening: corrupted or future-extended state shouldn't be
    // silently nuked. Key 9 is outside the 0..3 row range — it stays.
    const input = { 0: 'A', 1: 'B', 9: 'GHOST' };
    const out = reorderRecord(input, 0, 1, 4);
    // 0 → 1, 1 → 0, ghost key stays at 9.
    expect(out[0]).toBe('B');
    expect(out[1]).toBe('A');
    expect(out[9]).toBe('GHOST');
  });

  it('skips non-integer keys without crashing', () => {
    // Object.entries can yield string keys; defensive guard avoids
    // crashes on weird inputs.
    const input = { 0: 'A', 1: 'B', NaN: 'X' } as unknown as Record<number, string>;
    const out = reorderRecord(input, 0, 1, 2);
    expect(out[0]).toBe('B');
    expect(out[1]).toBe('A');
    // NaN string key dropped (Number('NaN') === NaN, not integer).
    expect(Object.values(out)).not.toContain('X');
  });
});

describe('reorderSingleIndex', () => {
  it('returns null for null input', () => {
    expect(reorderSingleIndex(null, 0, 2, 4)).toBeNull();
  });

  it('returns the moved index when index === from', () => {
    expect(reorderSingleIndex(0, 0, 2, 4)).toBe(2);
  });

  it('shifts indexes that move forward through the gap', () => {
    // length 4; move 0 → 2. Index 1 becomes 0, index 2 becomes 1.
    expect(reorderSingleIndex(1, 0, 2, 4)).toBe(0);
    expect(reorderSingleIndex(2, 0, 2, 4)).toBe(1);
  });

  it('leaves indexes outside the affected range untouched', () => {
    expect(reorderSingleIndex(3, 0, 2, 4)).toBe(3);
  });
});

describe('reorderProductionDocState — full atomic reorder', () => {
  it('reorders rows + every state slice consistently (forward move)', () => {
    const rows = [makeRow('A'), makeRow('B'), makeRow('C'), makeRow('D')];
    const rowImages = ['img-A', 'img-B', 'img-C', 'img-D'];
    const rowVideoClips: Record<number, { status: string } | null> = {
      0: { status: 'ready' },
      1: { status: 'generating' },
      2: null,
      3: { status: 'failed' },
    };
    const rowOverlays: Record<number, { status: string }> = {
      0: { status: 'done' },
      3: { status: 'idle' },
    };
    const rowBatchStubs: Record<number, { id: string } | null> = {
      1: { id: 'stub-B' },
    };

    const out = reorderProductionDocState(
      {
        rows,
        rowImages,
        rowVideoClips,
        rowOverlays,
        rowBatchStubs,
        expandedRow: 1, // we had row B expanded
      },
      1, // move B …
      3, // … to the end. Result: A C D B
    );

    expect(out.rows.map((r) => r.script_text)).toEqual(['A', 'C', 'D', 'B']);
    expect(out.rowImages).toEqual(['img-A', 'img-C', 'img-D', 'img-B']);
    expect(out.rowVideoClips).toEqual({
      0: { status: 'ready' },         // A stayed
      1: null,                         // was 2 (C had null)
      2: { status: 'failed' },         // was 3 (D)
      3: { status: 'generating' },     // was 1 (B)
    });
    expect(out.rowOverlays).toEqual({
      0: { status: 'done' },           // A stayed
      2: { status: 'idle' },           // was 3 (D shifted back to 2)
    });
    expect(out.rowBatchStubs).toEqual({
      3: { id: 'stub-B' },             // was 1, follows B to position 3
    });
    // The selection follows the moved row.
    expect(out.expandedRow).toBe(3);
  });

  it('reorders rows + slices consistently (backward move)', () => {
    const rows = [makeRow('A'), makeRow('B'), makeRow('C'), makeRow('D')];
    const rowImages = ['img-A', 'img-B', 'img-C', 'img-D'];

    const out = reorderProductionDocState(
      { rows, rowImages, expandedRow: 0 },
      3, // move D …
      1, // … to position 1. Result: A D B C
    );

    expect(out.rows.map((r) => r.script_text)).toEqual(['A', 'D', 'B', 'C']);
    expect(out.rowImages).toEqual(['img-A', 'img-D', 'img-B', 'img-C']);
    expect(out.expandedRow).toBe(0); // A stayed put
  });

  it('shifts expandedRow when it sits in the gap', () => {
    const rows = [makeRow('A'), makeRow('B'), makeRow('C'), makeRow('D'), makeRow('E')];
    // Move index 0 → 3, expandedRow=2.
    // Before:  A B C D E (expanded C at idx 2)
    // After:   B C D A E. C is now at idx 1.
    const out = reorderProductionDocState({ rows, expandedRow: 2 }, 0, 3);
    expect(out.expandedRow).toBe(1);
  });

  it('no-ops cleanly when from === to', () => {
    const rows = [makeRow('A'), makeRow('B')];
    const out = reorderProductionDocState({ rows, expandedRow: 0 }, 1, 1);
    expect(out.rows.map((r) => r.script_text)).toEqual(['A', 'B']);
    expect(out.expandedRow).toBe(0);
  });

  it('no-ops cleanly when indexes are out of range', () => {
    const rows = [makeRow('A'), makeRow('B')];
    const out = reorderProductionDocState({ rows, expandedRow: 0 }, -1, 0);
    expect(out.rows.map((r) => r.script_text)).toEqual(['A', 'B']);
    expect(out.expandedRow).toBe(0);
  });

  it('handles partial state (only rows provided)', () => {
    const rows = [makeRow('A'), makeRow('B'), makeRow('C')];
    const out = reorderProductionDocState({ rows }, 0, 2);
    expect(out.rows.map((r) => r.script_text)).toEqual(['B', 'C', 'A']);
    expect(out.rowImages).toBeUndefined();
    expect(out.rowVideoClips).toBeUndefined();
    expect(out.rowOverlays).toBeUndefined();
    expect(out.rowBatchStubs).toBeUndefined();
    expect(out.expandedRow).toBeNull();
  });
});

describe('deleteIndexMap', () => {
  it('marks the deleted index as null and shifts higher indexes down', () => {
    const map = deleteIndexMap(2, 5);
    expect(map[0]).toBe(0);
    expect(map[1]).toBe(1);
    expect(map[2]).toBeNull();
    expect(map[3]).toBe(2);
    expect(map[4]).toBe(3);
  });
});

describe('deleteFromArray', () => {
  it('removes the element and returns a new array', () => {
    expect(deleteFromArray(['a', 'b', 'c', 'd'], 1)).toEqual(['a', 'c', 'd']);
  });

  it('returns a copy for out-of-range indexes (defensive)', () => {
    expect(deleteFromArray(['a', 'b'], -1)).toEqual(['a', 'b']);
    expect(deleteFromArray(['a', 'b'], 10)).toEqual(['a', 'b']);
  });

  it('does not mutate the input', () => {
    const input = ['a', 'b', 'c'];
    deleteFromArray(input, 1);
    expect(input).toEqual(['a', 'b', 'c']);
  });
});

describe('deleteFromRecord', () => {
  it('drops the deleted key and shifts higher keys down by 1', () => {
    const out = deleteFromRecord({ 0: 'A', 1: 'B', 2: 'C', 3: 'D' }, 1, 4);
    expect(out).toEqual({ 0: 'A', 1: 'C', 2: 'D' });
  });

  it('preserves out-of-range integer keys unchanged', () => {
    const out = deleteFromRecord({ 0: 'A', 9: 'GHOST' }, 0, 2);
    // Index 0 dropped, ghost key 9 stays.
    expect(out).toEqual({ 9: 'GHOST' });
  });

  it('skips non-integer keys without crashing', () => {
    const input = { 0: 'A', 1: 'B', NaN: 'X' } as unknown as Record<number, string>;
    const out = deleteFromRecord(input, 0, 2);
    expect(out[0]).toBe('B');
  });
});

describe('deleteSingleIndex', () => {
  it('returns null when ref equals the deleted index', () => {
    expect(deleteSingleIndex(2, 2, 5)).toBeNull();
  });
  it('returns null for null input', () => {
    expect(deleteSingleIndex(null, 2, 5)).toBeNull();
  });
  it('shifts higher indexes down by 1', () => {
    expect(deleteSingleIndex(3, 1, 5)).toBe(2);
  });
  it('leaves lower indexes untouched', () => {
    expect(deleteSingleIndex(0, 2, 5)).toBe(0);
  });
});

describe('deleteRowFromProductionDocState — full atomic delete', () => {
  it('drops the row + every slice slot AND shifts higher state down', () => {
    const rows = [makeRow('A'), makeRow('B'), makeRow('C'), makeRow('D')];
    const rowImages = ['img-A', 'img-B', 'img-C', 'img-D'];
    const rowVideoClips: Record<number, { status: string } | null> = {
      0: { status: 'ready' },
      1: { status: 'generating' },
      2: null,
      3: { status: 'failed' },
    };
    const rowOverlays: Record<number, { status: string }> = {
      0: { status: 'done' },
      3: { status: 'idle' },
    };

    const out = deleteRowFromProductionDocState(
      {
        rows,
        rowImages,
        rowVideoClips,
        rowOverlays,
        expandedRow: 1,
      },
      1, // delete row B
    );

    expect(out.rows.map((r) => r.script_text)).toEqual(['A', 'C', 'D']);
    expect(out.rowImages).toEqual(['img-A', 'img-C', 'img-D']);
    expect(out.rowVideoClips).toEqual({
      0: { status: 'ready' },           // A stayed
      1: null,                           // was 2 (C had null)
      2: { status: 'failed' },           // was 3 (D shifted to 2)
    });
    expect(out.rowOverlays).toEqual({
      0: { status: 'done' },             // A stayed
      2: { status: 'idle' },             // was 3 (D shifted to 2)
    });
    // Selection collapsed: was pointing at the deleted row.
    expect(out.expandedRow).toBeNull();
  });

  it('shifts expandedRow when it sits above the deleted index', () => {
    const rows = [makeRow('A'), makeRow('B'), makeRow('C')];
    const out = deleteRowFromProductionDocState({ rows, expandedRow: 2 }, 0);
    // Row A deleted; C was at idx 2, now at idx 1.
    expect(out.expandedRow).toBe(1);
  });

  it('no-ops cleanly on out-of-range delete', () => {
    const rows = [makeRow('A')];
    const out = deleteRowFromProductionDocState({ rows, expandedRow: 0 }, 5);
    expect(out.rows.map((r) => r.script_text)).toEqual(['A']);
    expect(out.expandedRow).toBe(0);
  });
});

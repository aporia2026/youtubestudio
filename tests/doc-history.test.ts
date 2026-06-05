import { describe, expect, it } from 'vitest';
import {
  docHistoryCanRedo,
  docHistoryCanUndo,
  docHistoryCurrent,
  initDocHistory,
  reduceDocHistory,
} from '@/lib/timeline-editor/doc-history';

describe('initDocHistory', () => {
  it('seeds a single-entry stack with pointer 0', () => {
    const s = initDocHistory(42);
    expect(s.stack).toEqual([42]);
    expect(s.pointer).toBe(0);
  });

  it('uses the supplied maxDepth', () => {
    const s = initDocHistory('x', 5);
    expect(s.maxDepth).toBe(5);
  });
});

describe('reduceDocHistory — commit', () => {
  it('truncates the redo branch and pushes', () => {
    let s = initDocHistory(0);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    s = reduceDocHistory(s, { kind: 'commit', next: 2 });
    s = reduceDocHistory(s, { kind: 'undo' });
    expect(docHistoryCurrent(s)).toBe(1);
    s = reduceDocHistory(s, { kind: 'commit', next: 99 });
    expect(s.stack).toEqual([0, 1, 99]);
    expect(s.pointer).toBe(2);
  });

  it('returns the same state object on no-op (head === next)', () => {
    const s = initDocHistory(7);
    const out = reduceDocHistory(s, { kind: 'commit', next: 7 });
    expect(out).toBe(s);
  });

  it('clips from the front when stack exceeds maxDepth', () => {
    let s = initDocHistory(0, 3);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    s = reduceDocHistory(s, { kind: 'commit', next: 2 });
    expect(s.stack).toEqual([0, 1, 2]);
    s = reduceDocHistory(s, { kind: 'commit', next: 3 });
    expect(s.stack).toEqual([1, 2, 3]);
    expect(s.pointer).toBe(2);
    s = reduceDocHistory(s, { kind: 'commit', next: 4 });
    expect(s.stack).toEqual([2, 3, 4]);
  });

  it('keeps pointer pointing at the new head after clip', () => {
    let s = initDocHistory(0, 2);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    s = reduceDocHistory(s, { kind: 'commit', next: 2 });
    expect(docHistoryCurrent(s)).toBe(2);
    expect(s.stack).toEqual([1, 2]);
  });
});

describe('reduceDocHistory — live', () => {
  it('replaces head WITHOUT advancing the pointer', () => {
    let s = initDocHistory(0);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    s = reduceDocHistory(s, { kind: 'live', next: 99 });
    expect(s.pointer).toBe(1);
    expect(s.stack).toEqual([0, 99]);
  });

  it('returns same state on no-op', () => {
    let s = initDocHistory(0);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    const out = reduceDocHistory(s, { kind: 'live', next: 1 });
    expect(out).toBe(s);
  });

  it('a commit after a live captures the live value into history', () => {
    let s = initDocHistory(0);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    s = reduceDocHistory(s, { kind: 'live', next: 50 });
    s = reduceDocHistory(s, { kind: 'live', next: 100 });
    s = reduceDocHistory(s, { kind: 'commit', next: 100 });
    // No double-entry — commit with same value as live head bails.
    expect(s.stack).toEqual([0, 100]);
    expect(s.pointer).toBe(1);
  });
});

describe('reduceDocHistory — undo / redo', () => {
  it('undo decrements pointer; redo increments it', () => {
    let s = initDocHistory(0);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    s = reduceDocHistory(s, { kind: 'commit', next: 2 });
    s = reduceDocHistory(s, { kind: 'undo' });
    expect(docHistoryCurrent(s)).toBe(1);
    s = reduceDocHistory(s, { kind: 'undo' });
    expect(docHistoryCurrent(s)).toBe(0);
    s = reduceDocHistory(s, { kind: 'redo' });
    expect(docHistoryCurrent(s)).toBe(1);
    s = reduceDocHistory(s, { kind: 'redo' });
    expect(docHistoryCurrent(s)).toBe(2);
  });

  it('undo at the start is a no-op (returns same state)', () => {
    const s = initDocHistory(0);
    expect(reduceDocHistory(s, { kind: 'undo' })).toBe(s);
  });

  it('redo at the end is a no-op (returns same state)', () => {
    let s = initDocHistory(0);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    expect(reduceDocHistory(s, { kind: 'redo' })).toBe(s);
  });

  it('canUndo / canRedo reflect the boundary', () => {
    let s = initDocHistory(0);
    expect(docHistoryCanUndo(s)).toBe(false);
    expect(docHistoryCanRedo(s)).toBe(false);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    expect(docHistoryCanUndo(s)).toBe(true);
    expect(docHistoryCanRedo(s)).toBe(false);
    s = reduceDocHistory(s, { kind: 'undo' });
    expect(docHistoryCanUndo(s)).toBe(false);
    expect(docHistoryCanRedo(s)).toBe(true);
  });
});

describe('reduceDocHistory — beginBatch', () => {
  it('pushes a duplicate of the current head and advances the pointer', () => {
    let s = initDocHistory(7);
    s = reduceDocHistory(s, { kind: 'beginBatch' });
    expect(s.stack).toEqual([7, 7]);
    expect(s.pointer).toBe(1);
  });

  it('preserves pre-batch state when live updates mutate the new head', () => {
    // Simulates the drag-resize flow:
    //   start  → stack=[A], pointer=0
    //   resizeStart → beginBatch → stack=[A, A], pointer=1
    //   resizing × 3 → live → stack=[A, B_final], pointer=1
    //   resizeEnd → commit (no-op because head === next)
    //   undo → pointer=0 → user sees A again ✓
    let s = initDocHistory('A');
    s = reduceDocHistory(s, { kind: 'beginBatch' });
    s = reduceDocHistory(s, { kind: 'live', next: 'B1' });
    s = reduceDocHistory(s, { kind: 'live', next: 'B2' });
    s = reduceDocHistory(s, { kind: 'live', next: 'B_final' });
    expect(s.stack).toEqual(['A', 'B_final']);
    expect(s.pointer).toBe(1);
    // The commit-with-same-value bail still works correctly.
    s = reduceDocHistory(s, { kind: 'commit', next: 'B_final' });
    expect(s.stack).toEqual(['A', 'B_final']);
    // Undo brings the user back to A.
    s = reduceDocHistory(s, { kind: 'undo' });
    expect(docHistoryCurrent(s)).toBe('A');
    // Redo goes forward to the final drag state.
    s = reduceDocHistory(s, { kind: 'redo' });
    expect(docHistoryCurrent(s)).toBe('B_final');
  });

  it('truncates the redo branch on beginBatch (just like commit)', () => {
    let s = initDocHistory(0);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    s = reduceDocHistory(s, { kind: 'commit', next: 2 });
    s = reduceDocHistory(s, { kind: 'undo' });
    // Pointer is now at 1 (value 1); 2 is in the future.
    s = reduceDocHistory(s, { kind: 'beginBatch' });
    expect(s.stack).toEqual([0, 1, 1]);
    expect(s.pointer).toBe(2);
  });

  it('respects maxDepth by clipping from the front', () => {
    let s = initDocHistory(0, 3);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    s = reduceDocHistory(s, { kind: 'commit', next: 2 });
    expect(s.stack).toEqual([0, 1, 2]);
    s = reduceDocHistory(s, { kind: 'beginBatch' });
    expect(s.stack).toEqual([1, 2, 2]);
    expect(s.pointer).toBe(2);
  });
});

describe('reduceDocHistory — reset', () => {
  it('throws the stack away and starts over', () => {
    let s = initDocHistory(0);
    s = reduceDocHistory(s, { kind: 'commit', next: 1 });
    s = reduceDocHistory(s, { kind: 'commit', next: 2 });
    s = reduceDocHistory(s, { kind: 'reset', next: 999 });
    expect(s.stack).toEqual([999]);
    expect(s.pointer).toBe(0);
  });

  it('preserves maxDepth on reset', () => {
    let s = initDocHistory(0, 7);
    s = reduceDocHistory(s, { kind: 'reset', next: 1 });
    expect(s.maxDepth).toBe(7);
  });
});

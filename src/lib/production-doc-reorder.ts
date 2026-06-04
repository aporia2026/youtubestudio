/**
 * Pure helper for reordering a production-doc row across all of the
 * page-level state slices that are indexed by row position. The
 * reorder MUST be atomic — if we shifted rows but left rowImages /
 * rowVideoClips / rowOverlays / rowBatchStubs at the old indexes the
 * inspector would show the wrong image for the wrong row.
 *
 * Polish PR follow-up for the production-doc redesign — see
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * `rowLockSignatures` is intentionally NOT reindexed because it's
 * keyed by a content signature (timecode + visual_description), not
 * by row index. The signature follows the row through any reorder.
 */

import type { ProductionRow } from '@/remotion/utils';

/**
 * Map an old index to its new index after moving `from` → `to`.
 * `length` is the array length BEFORE the move.
 *
 * Exported so callers can also relocate single-index references
 * (e.g. `expandedRow` selection state).
 */
export function reorderIndexMap(
  from: number,
  to: number,
  length: number,
): Record<number, number> {
  const map: Record<number, number> = {};
  if (from === to) {
    for (let i = 0; i < length; i++) map[i] = i;
    return map;
  }
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = 0; i < length; i++) {
    if (i === from) {
      map[i] = to;
    } else if (i < lo || i > hi) {
      map[i] = i;
    } else if (from < to) {
      // Moving forward: rows between (from, to] shift back by one.
      map[i] = i - 1;
    } else {
      // Moving backward: rows between [to, from) shift forward by one.
      map[i] = i + 1;
    }
  }
  return map;
}

/** Apply the reorder map to a positional array. */
export function reorderArray<T>(arr: ReadonlyArray<T>, from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) {
    return [...arr];
  }
  const result = [...arr];
  const [moved] = result.splice(from, 1);
  result.splice(to, 0, moved);
  return result;
}

/** Apply the reorder map to an index-keyed record. Values absent in
 *  the input record are absent in the output (no synthetic defaults).
 *  Out-of-range keys (>= length, or non-integer / NaN) are preserved
 *  unchanged so corrupted or future-extended state isn't silently
 *  dropped. */
export function reorderRecord<T>(
  record: Readonly<Record<number, T>>,
  from: number,
  to: number,
  length: number,
): Record<number, T> {
  if (from === to) return { ...record };
  const map = reorderIndexMap(from, to, length);
  const result: Record<number, T> = {};
  for (const [oldKeyStr, value] of Object.entries(record)) {
    const oldKey = Number(oldKeyStr);
    if (!Number.isInteger(oldKey)) continue;
    const mapped = map[oldKey];
    const newKey = mapped !== undefined ? mapped : oldKey;
    result[newKey] = value;
  }
  return result;
}

/** Map a single 0-based index reference through the reorder. Returns
 *  `null` for `null` input. */
export function reorderSingleIndex(
  index: number | null,
  from: number,
  to: number,
  length: number,
): number | null {
  if (index === null) return null;
  if (from === to) return index;
  const map = reorderIndexMap(from, to, length);
  return map[index] ?? index;
}

/** The full reorderable state bundle. Each slice is optional so the
 *  helper can be called by callers that don't track every state
 *  type. */
export interface ReorderableProductionState<RImage, RVideo, ROverlay, RStub> {
  rows: ReadonlyArray<ProductionRow>;
  rowImages?: ReadonlyArray<RImage>;
  rowVideoClips?: Readonly<Record<number, RVideo | null>>;
  rowOverlays?: Readonly<Record<number, ROverlay>>;
  rowBatchStubs?: Readonly<Record<number, RStub | null>>;
  expandedRow?: number | null;
}

export interface ReorderedProductionState<RImage, RVideo, ROverlay, RStub> {
  rows: ProductionRow[];
  rowImages: RImage[] | undefined;
  rowVideoClips: Record<number, RVideo | null> | undefined;
  rowOverlays: Record<number, ROverlay> | undefined;
  rowBatchStubs: Record<number, RStub | null> | undefined;
  expandedRow: number | null | undefined;
}

/**
 * Compute the post-reorder state for every row-indexed slice. Returns
 * a NEW object for each slice that's present; absent slices stay
 * `undefined` so callers can pass partial state. No-ops cleanly when
 * `from === to` or either index is out of range.
 */
export function reorderProductionDocState<RImage, RVideo, ROverlay, RStub>(
  state: ReorderableProductionState<RImage, RVideo, ROverlay, RStub>,
  from: number,
  to: number,
): ReorderedProductionState<RImage, RVideo, ROverlay, RStub> {
  const length = state.rows.length;
  const inRange = from >= 0 && to >= 0 && from < length && to < length;
  if (!inRange || from === to) {
    return {
      rows: [...state.rows],
      rowImages: state.rowImages ? [...state.rowImages] : undefined,
      rowVideoClips: state.rowVideoClips ? { ...state.rowVideoClips } : undefined,
      rowOverlays: state.rowOverlays ? { ...state.rowOverlays } : undefined,
      rowBatchStubs: state.rowBatchStubs ? { ...state.rowBatchStubs } : undefined,
      expandedRow: state.expandedRow ?? null,
    };
  }
  return {
    rows: reorderArray(state.rows, from, to),
    rowImages: state.rowImages ? reorderArray(state.rowImages, from, to) : undefined,
    rowVideoClips: state.rowVideoClips
      ? reorderRecord(state.rowVideoClips, from, to, length)
      : undefined,
    rowOverlays: state.rowOverlays
      ? reorderRecord(state.rowOverlays, from, to, length)
      : undefined,
    rowBatchStubs: state.rowBatchStubs
      ? reorderRecord(state.rowBatchStubs, from, to, length)
      : undefined,
    expandedRow: reorderSingleIndex(state.expandedRow ?? null, from, to, length),
  };
}

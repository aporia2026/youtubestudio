/**
 * Pure mutation helpers for the CapCut-style timeline editor.
 *
 * Every editor interaction (drag-trim, drag-resize, split, cut,
 * reorder) lands here as a `(doc, params) => nextDoc` function.
 * Pure on purpose — the component shell stays trivial, the tests
 * stay fast, and undo/redo (M5) just keeps an array of these
 * doc snapshots.
 *
 * Plan: _plans/2026-06-05-capcut-timeline-editor.md.
 */

import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import { DEFAULT_FPS, framesToMs, snapMsToFrame } from '@/lib/timeline-editor/frame-math';
import { rowDurationMs, rowIndexAtMs } from './timeline-data-adapter';

export interface MutationOptions {
  fps?: number;
  /** Minimum allowed duration in ms, after frame-snap is applied.
   *  Default = 1 frame at the supplied fps so the user can scrub
   *  all the way down to a single visible frame. */
  minDurationMs?: number;
}

/** Resolve { fps, minDurationMs } with sensible defaults. */
function resolveOpts(opts: MutationOptions = {}): Required<MutationOptions> {
  const fps = opts.fps ?? DEFAULT_FPS;
  const minDurationMs = opts.minDurationMs ?? framesToMs(1, fps);
  return { fps, minDurationMs };
}

/** Trim a row's overall duration by setting `duration_override_ms`.
 *  Used by drag-trim (clip edge) and drag-resize (clip body) — both
 *  reduce to the same operation: "this row should now be N ms long."
 *
 *  Snaps the supplied ms to a frame boundary; refuses to shrink
 *  below `minDurationMs` (default = 1 frame). Returns the input doc
 *  unchanged when the trim is a no-op (same effective duration) so
 *  React render bails on object identity. */
export function trimRowDuration(
  doc: ProductionDoc,
  rowIndex: number,
  newDurationMs: number,
  opts: MutationOptions = {},
): ProductionDoc {
  if (rowIndex < 0 || rowIndex >= doc.rows.length) return doc;
  const { fps, minDurationMs } = resolveOpts(opts);
  const snapped = Math.max(minDurationMs, snapMsToFrame(newDurationMs, fps));
  const target = doc.rows[rowIndex];
  if (target.duration_override_ms === snapped) return doc;
  const nextRows: ProductionRow[] = doc.rows.map((row, i) =>
    i === rowIndex ? { ...row, duration_override_ms: snapped } : row,
  );
  return { ...doc, rows: nextRows };
}

/** Clear any duration override on a row so it falls back to the
 *  timecode-derived duration. Used by the "Reset duration" right-
 *  click menu (M4+). */
export function resetRowDuration(doc: ProductionDoc, rowIndex: number): ProductionDoc {
  if (rowIndex < 0 || rowIndex >= doc.rows.length) return doc;
  const target = doc.rows[rowIndex];
  if (target.duration_override_ms === undefined) return doc;
  const nextRows: ProductionRow[] = doc.rows.map((row, i) => {
    if (i !== rowIndex) return row;
    const next = { ...row };
    delete next.duration_override_ms;
    return next;
  });
  return { ...doc, rows: nextRows };
}

/** Split the row under `playheadMsAbsolute` into two rows at the
 *  cut point. The first half inherits the original's content
 *  (same script_text, ai_image_prompt, image_url, etc.) and gets a
 *  `duration_override_ms` of `localCutMs`. The second half clones
 *  the same content and gets a `duration_override_ms` of the
 *  remainder. Both halves pin their durations so the auto-cascade
 *  doesn't reflow them on the next render.
 *
 *  Returns the input doc unchanged when:
 *    - The playhead is outside every row.
 *    - The cut point lands within `minDurationMs` of either edge
 *      (no point creating a one-frame sliver).
 *
 *  Exported for unit tests; the component calls it via the `S` key.
 */
export function splitRowAtPlayheadMs(
  doc: ProductionDoc,
  playheadMsAbsolute: number,
  opts: MutationOptions = {},
): ProductionDoc {
  const { fps, minDurationMs } = resolveOpts(opts);
  const idx = rowIndexAtMs(doc, playheadMsAbsolute);
  if (idx < 0) return doc;
  const row = doc.rows[idx];
  // Recompute rowStart since rowIndexAtMs doesn't return it.
  let rowStartMs = 0;
  for (let i = 0; i < idx; i++) rowStartMs += rowDurationMs(doc.rows[i]);
  const originalDuration = rowDurationMs(row);
  const localCutMs = snapMsToFrame(playheadMsAbsolute - rowStartMs, fps);
  if (localCutMs < minDurationMs) return doc;
  if (localCutMs > originalDuration - minDurationMs) return doc;

  const firstHalf: ProductionRow = {
    ...row,
    duration_override_ms: localCutMs,
    pin_duration: true,
  };
  const secondHalfDuration = snapMsToFrame(originalDuration - localCutMs, fps);
  const secondHalf: ProductionRow = {
    ...row,
    duration_override_ms: secondHalfDuration,
    pin_duration: true,
  };
  // Per-row image fields: the second half re-uses the same image
  // (it's the same scene, just continuing). variant_index would
  // need bumping if we wanted to mark them as siblings — defer to
  // a future enhancement when we add variant chains here.
  const nextRows: ProductionRow[] = [
    ...doc.rows.slice(0, idx),
    firstHalf,
    secondHalf,
    ...doc.rows.slice(idx + 1),
  ];
  return { ...doc, rows: nextRows };
}

/** Remove the row at `rowIndex` from the doc — wires the `Del`
 *  keyboard shortcut and the right-click "Cut clip" menu (M4). */
export function cutRow(doc: ProductionDoc, rowIndex: number): ProductionDoc {
  if (rowIndex < 0 || rowIndex >= doc.rows.length) return doc;
  // Refuse to cut the last remaining row — the editor needs at
  // least one clip on the timeline or there's nothing to render.
  if (doc.rows.length === 1) return doc;
  const nextRows = [...doc.rows.slice(0, rowIndex), ...doc.rows.slice(rowIndex + 1)];
  return { ...doc, rows: nextRows };
}

/** Re-order a row from `fromIndex` to `toIndex`. `toIndex` is the
 *  POST-REMOVAL index: 0 means "before everything," N-1 (where N is
 *  the doc's row count) means "after everything." Returns the same
 *  doc when the move is a no-op or either index is out of range.
 *
 *  Used by drag-reorder (M4). Pair with `targetIndexFromDropMs`
 *  to compute `toIndex` from a library drop event's startMs. */
export function moveRow(doc: ProductionDoc, fromIndex: number, toIndex: number): ProductionDoc {
  if (fromIndex < 0 || fromIndex >= doc.rows.length) return doc;
  // Allowable toIndex range is [0, rows.length - 1] after removal,
  // i.e. [0, rows.length - 1].
  if (toIndex < 0 || toIndex >= doc.rows.length) return doc;
  if (fromIndex === toIndex) return doc;
  const without = [...doc.rows.slice(0, fromIndex), ...doc.rows.slice(fromIndex + 1)];
  const nextRows = [
    ...without.slice(0, toIndex),
    doc.rows[fromIndex],
    ...without.slice(toIndex),
  ];
  return { ...doc, rows: nextRows };
}

/** Set or clear a row's incoming transition. v1 supports only
 *  `'cross-fade'` and `null` — the same domain the existing Remotion
 *  scenes read via `row.transition_in`. */
export function setRowTransitionIn(
  doc: ProductionDoc,
  rowIndex: number,
  transition: 'cross-fade' | null,
): ProductionDoc {
  if (rowIndex < 0 || rowIndex >= doc.rows.length) return doc;
  const target = doc.rows[rowIndex];
  const current = target.transition_in ?? null;
  if (current === transition) return doc;
  const nextRows: ProductionRow[] = doc.rows.map((row, i) => {
    if (i !== rowIndex) return row;
    const next = { ...row };
    if (transition === null) {
      delete next.transition_in;
    } else {
      next.transition_in = transition;
    }
    return next;
  });
  return { ...doc, rows: nextRows };
}

/** Mute or unmute a row's audio. v1 maps to `row.muted` which the
 *  Remotion scenes already read. Useful keyboard shortcut: `M`. */
export function setRowMuted(doc: ProductionDoc, rowIndex: number, muted: boolean): ProductionDoc {
  if (rowIndex < 0 || rowIndex >= doc.rows.length) return doc;
  const target = doc.rows[rowIndex];
  if ((target.muted === true) === muted) return doc;
  const nextRows: ProductionRow[] = doc.rows.map((row, i) =>
    i === rowIndex ? { ...row, muted } : row,
  );
  return { ...doc, rows: nextRows };
}

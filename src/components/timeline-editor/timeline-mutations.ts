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

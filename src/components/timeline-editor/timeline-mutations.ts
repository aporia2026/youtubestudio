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

import type { ProductionDoc, ProductionRow, VoiceoverSegment } from '@/remotion/utils';
import { DEFAULT_FPS, framesToMs, snapMsToFrame } from '@/lib/timeline-editor/frame-math';
import {
  computeRowIntervals,
  rowIndexAtMs,
  voiceoverSegmentIndexAtMs,
} from './timeline-data-adapter';

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
 *  React render bails on object identity.
 *
 *  Sets `pin_duration: true` so a subsequent forced-alignment pass
 *  (production render with voiceover) doesn't silently re-time the
 *  row and erase the user's explicit choice. The legacy editor's
 *  RESIZE_SHOT command (`src/lib/editor/store.ts`) already does
 *  this — the timeline editor was the odd one out before
 *  2026-06-06. */
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
  if (target.duration_override_ms === snapped && target.pin_duration === true) return doc;
  // Observability: every trim emits a row-level log so a "preview
  // didn't change" report can be diagnosed against the actual ms
  // written and the prior value. Pair with `[render-timing]
  // overridesHonored` in productionDocToVideoConfig to confirm the
  // value made it all the way to the composition.
  if (typeof console !== 'undefined' && console.info) {
    console.info('[timeline-editor trim]', {
      rowIndex,
      requestedMs: newDurationMs,
      snappedMs: snapped,
      previousOverrideMs: target.duration_override_ms ?? null,
      previousPinDuration: target.pin_duration ?? null,
      fps,
    });
  }
  const nextRows: ProductionRow[] = doc.rows.map((row, i) =>
    i === rowIndex ? { ...row, duration_override_ms: snapped, pin_duration: true } : row,
  );
  return { ...doc, rows: nextRows };
}

/** Clear any duration override on a row so it falls back to the
 *  timecode-derived duration. Used by the "Reset duration" right-
 *  click menu (M4+). Also clears `pin_duration` so alignment is
 *  allowed to take the row back over — matches the legacy editor's
 *  "Reset timing to alignment" semantics. */
export function resetRowDuration(doc: ProductionDoc, rowIndex: number): ProductionDoc {
  if (rowIndex < 0 || rowIndex >= doc.rows.length) return doc;
  const target = doc.rows[rowIndex];
  if (target.duration_override_ms === undefined && target.pin_duration === undefined) return doc;
  const nextRows: ProductionRow[] = doc.rows.map((row, i) => {
    if (i !== rowIndex) return row;
    const next = { ...row };
    delete next.duration_override_ms;
    delete next.pin_duration;
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
  // Pull row start + duration from the same cascade table the
  // Player sees so a split-at-playhead lands at the visual cursor
  // position, not a literal-timecode-range offset that would drift
  // from where the user is pointing.
  const intervals = computeRowIntervals(doc);
  const idx = rowIndexAtMs(doc, playheadMsAbsolute);
  if (idx < 0) return doc;
  const row = doc.rows[idx];
  const rowStartMs = intervals[idx].startMs;
  const originalDuration = intervals[idx].durationMs;
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

// ─── Voiceover segment mutations (M6) ────────────────────────────────
//
// Parallels the row mutations. Voiceover segments share the same
// cumulative duration model as ProductionRows — splitting at the
// playhead bisects a segment, trimming changes durationMs, cutting
// removes a segment from the array, moving re-orders.

let voiceoverIdCounter = 1;
function nextVoiceoverId(): string {
  // Monotonically increasing in-process counter — segments share
  // process lifetime so collisions don't matter; we just need
  // stable React keys.
  voiceoverIdCounter += 1;
  return `vo-${Date.now().toString(36)}-${voiceoverIdCounter.toString(36)}`;
}

/** Trim a voiceover segment's duration in place. Same semantics as
 *  trimRowDuration: snap to frame, enforce ≥1 frame floor, return
 *  object-identity on no-op. */
export function trimVoiceoverSegmentDuration(
  doc: ProductionDoc,
  segmentIndex: number,
  newDurationMs: number,
  opts: MutationOptions = {},
): ProductionDoc {
  const segments = doc.voiceover_segments;
  if (!segments || segmentIndex < 0 || segmentIndex >= segments.length) return doc;
  const { fps, minDurationMs } = resolveOpts(opts);
  const snapped = Math.max(minDurationMs, snapMsToFrame(newDurationMs, fps));
  if (segments[segmentIndex].durationMs === snapped) return doc;
  const next: VoiceoverSegment[] = segments.map((seg, i) =>
    i === segmentIndex ? { ...seg, durationMs: snapped } : seg,
  );
  return { ...doc, voiceover_segments: next };
}

/** Split the voiceover segment under `playheadMsAbsolute` at the
 *  cut point. The first half keeps the source offset; the second
 *  half advances source offset by the cut amount so playback
 *  continues from where the first half left off (no audio gap).
 *
 *  Returns the same doc on out-of-range playhead or when the cut
 *  would land within `minDurationMs` of either edge. */
export function splitVoiceoverSegmentAtPlayheadMs(
  doc: ProductionDoc,
  playheadMsAbsolute: number,
  opts: MutationOptions = {},
): ProductionDoc {
  const segments = doc.voiceover_segments;
  if (!segments || segments.length === 0) return doc;
  const { fps, minDurationMs } = resolveOpts(opts);
  const idx = voiceoverSegmentIndexAtMs(doc, playheadMsAbsolute);
  if (idx < 0) return doc;
  const seg = segments[idx];
  let segStartMs = 0;
  for (let i = 0; i < idx; i++) segStartMs += segments[i].durationMs;
  const localCutMs = snapMsToFrame(playheadMsAbsolute - segStartMs, fps);
  if (localCutMs < minDurationMs) return doc;
  if (localCutMs > seg.durationMs - minDurationMs) return doc;
  const firstHalf: VoiceoverSegment = {
    ...seg,
    id: nextVoiceoverId(),
    durationMs: localCutMs,
  };
  const secondHalfDuration = snapMsToFrame(seg.durationMs - localCutMs, fps);
  const secondHalf: VoiceoverSegment = {
    ...seg,
    id: nextVoiceoverId(),
    sourceOffsetMs: seg.sourceOffsetMs + localCutMs,
    durationMs: secondHalfDuration,
  };
  const nextSegments = [
    ...segments.slice(0, idx),
    firstHalf,
    secondHalf,
    ...segments.slice(idx + 1),
  ];
  return { ...doc, voiceover_segments: nextSegments };
}

/** Remove the voiceover segment at `segmentIndex`. Refuses to
 *  delete the last segment so the audio track always has at least
 *  one entry (or the track collapses entirely). */
export function cutVoiceoverSegment(doc: ProductionDoc, segmentIndex: number): ProductionDoc {
  const segments = doc.voiceover_segments;
  if (!segments || segmentIndex < 0 || segmentIndex >= segments.length) return doc;
  if (segments.length === 1) return doc;
  const nextSegments = [...segments.slice(0, segmentIndex), ...segments.slice(segmentIndex + 1)];
  return { ...doc, voiceover_segments: nextSegments };
}

/** Move a voiceover segment from one index to another. Pure array
 *  shuffle, same shape as `moveRow`. */
export function moveVoiceoverSegment(doc: ProductionDoc, fromIndex: number, toIndex: number): ProductionDoc {
  const segments = doc.voiceover_segments;
  if (!segments) return doc;
  if (fromIndex < 0 || fromIndex >= segments.length) return doc;
  if (toIndex < 0 || toIndex >= segments.length) return doc;
  if (fromIndex === toIndex) return doc;
  const without = [...segments.slice(0, fromIndex), ...segments.slice(fromIndex + 1)];
  const nextSegments = [
    ...without.slice(0, toIndex),
    segments[fromIndex],
    ...without.slice(toIndex),
  ];
  return { ...doc, voiceover_segments: nextSegments };
}

// ─── Existing row mutations (M2-M4) ──────────────────────────────────

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

/**
 * Convert a ProductionDoc into the data shape
 * `@xzdarcy/react-timeline-editor` expects, and back.
 *
 * The timeline library uses `seconds` as float; ProductionRow uses
 * `ms` integers. All conversions route through `frame-math.ts` so
 * the timeline stays frame-aligned.
 *
 * v1 mapping (M1 of the plan): each ProductionRow becomes ONE
 * TimelineAction on a single "video" track. The clip's start is
 * the cumulative duration of every prior row; its duration is
 * `duration_override_ms` if set, else parsed from the row's
 * timecode (`0:00-0:03`), else 3000ms (default minimum scene).
 *
 * Voiceover comes in M6 — for now the voiceover sits as a single
 * read-only clip on its own track if the doc carries
 * `total_duration` long enough to span all rows.
 */

import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import { msToSec } from '@/lib/timeline-editor/frame-math';

/** Default minimum scene duration when nothing else can be inferred. */
const DEFAULT_ROW_DURATION_MS = 3000;

/** Per-row computed timing — used both by the library adapter and by
 *  edit-time mutations (split-at-playhead needs to know row starts). */
export interface ComputedRowInterval {
  rowIndex: number;
  rowId: string;
  startMs: number;
  durationMs: number;
}

/** Library-side shape we feed to <Timeline />. Mirrors the
 *  TimelineRow / TimelineAction types the library exports — we
 *  duplicate the shape here so this file stays import-free of the
 *  library (the actual import lives in TimelineEditor.tsx). */
export interface TimelineRowData {
  id: string;
  actions: TimelineActionData[];
}

export interface TimelineActionData {
  id: string;
  start: number; // seconds
  end: number;   // seconds
  effectId: 'video' | 'voiceover';
  data: {
    rowIndex: number;
    scriptText: string;
    visualType: string;
    imageUrl: string;
    onScreenText: string;
    muted: boolean;
    /** Incoming transition kind — surfaced on the clip card so the
     *  user can see at a glance which clips cross-fade in. */
    transitionIn: 'cross-fade' | null;
  };
}

/** Parse a timecode like "0:00-0:03" or "01:23-01:25" into the
 *  duration in ms. Returns null on malformed input. */
export function parseTimecodeDurationMs(timecode: string | undefined): number | null {
  if (!timecode) return null;
  const m = /^(\d+):(\d{2})-(\d+):(\d{2})$/.exec(timecode.trim());
  if (!m) return null;
  const startSec = Number(m[1]) * 60 + Number(m[2]);
  const endSec = Number(m[3]) * 60 + Number(m[4]);
  const durationMs = (endSec - startSec) * 1000;
  return durationMs > 0 ? durationMs : null;
}

/** Compute the duration of one row in ms. Precedence:
 *  1. `duration_override_ms` (the editor's pinned value)
 *  2. parsed from `timecode`
 *  3. `DEFAULT_ROW_DURATION_MS` (3000ms)
 *  Pure — no DOM, no state. */
export function rowDurationMs(row: Pick<ProductionRow, 'duration_override_ms' | 'timecode'>): number {
  if (typeof row.duration_override_ms === 'number' && Number.isFinite(row.duration_override_ms) && row.duration_override_ms > 0) {
    return row.duration_override_ms;
  }
  const parsed = parseTimecodeDurationMs(row.timecode);
  if (parsed !== null) return parsed;
  return DEFAULT_ROW_DURATION_MS;
}

/** Walk the doc's rows once and produce a per-row interval table. */
export function computeRowIntervals(doc: Pick<ProductionDoc, 'rows'>): ComputedRowInterval[] {
  const out: ComputedRowInterval[] = [];
  let cursorMs = 0;
  for (let i = 0; i < doc.rows.length; i++) {
    const row = doc.rows[i];
    const durationMs = rowDurationMs(row);
    out.push({
      rowIndex: i,
      rowId: rowKeyFor(row, i),
      startMs: cursorMs,
      durationMs,
    });
    cursorMs += durationMs;
  }
  return out;
}

/** Stable per-row id used in TimelineAction keys. ProductionRow
 *  doesn't carry an inherent id, so we synthesize from the row index
 *  and a short hash of the timecode + script_text. The id survives
 *  drag-reorder because the adapter recomputes it from the current
 *  index on each pass; the library re-keys actions on each render. */
export function rowKeyFor(row: Pick<ProductionRow, 'timecode' | 'script_text'>, index: number): string {
  const hash = (row.timecode ?? '') + ':' + (row.script_text ?? '').slice(0, 16);
  return `row-${index}-${hash.length.toString(36)}`;
}

/** Total ms across all rows. */
export function totalDocDurationMs(doc: Pick<ProductionDoc, 'rows'>): number {
  return computeRowIntervals(doc).reduce((acc, r) => acc + r.durationMs, 0);
}

/** Map a playhead time (ms, absolute) to the row it falls inside.
 *  Returns -1 if the time is before the first row or after the last. */
export function rowIndexAtMs(doc: Pick<ProductionDoc, 'rows'>, atMs: number): number {
  if (atMs < 0) return -1;
  let cursorMs = 0;
  for (let i = 0; i < doc.rows.length; i++) {
    const d = rowDurationMs(doc.rows[i]);
    if (atMs >= cursorMs && atMs < cursorMs + d) return i;
    cursorMs += d;
  }
  return -1;
}

/** Given a doc, the index of a row currently being dragged, and the
 *  new absolute startMs the user dropped it at, return the row index
 *  where the row should be inserted (post-removal indexing).
 *
 *  Used by drag-reorder (M4). The cumulative data model can't hold a
 *  row at an arbitrary timeline position; we snap to the nearest
 *  insertion slot between existing rows. Slot N's anchor is the
 *  cumulative start of `rows-without-dragged[0..N-1]`.
 *
 *  Returns `fromIndex` unchanged when the closest slot is the row's
 *  current position (no-op), so the caller can compare to detect
 *  a moot drag and skip persistence. */
export function targetIndexFromDropMs(
  doc: Pick<ProductionDoc, 'rows'>,
  fromIndex: number,
  newStartMs: number,
): number {
  if (fromIndex < 0 || fromIndex >= doc.rows.length) return fromIndex;
  const withoutDragged = doc.rows.filter((_, i) => i !== fromIndex);
  // Gap k sits at the cumulative end of withoutDragged[0..k-1].
  const gapStarts: number[] = [0];
  let cursor = 0;
  for (const r of withoutDragged) {
    cursor += rowDurationMs(r);
    gapStarts.push(cursor);
  }
  // Closest gap. Tie-break to the left (smaller index).
  let bestGap = 0;
  let bestDist = Math.abs(newStartMs - gapStarts[0]);
  for (let i = 1; i < gapStarts.length; i++) {
    const d = Math.abs(newStartMs - gapStarts[i]);
    if (d < bestDist) {
      bestGap = i;
      bestDist = d;
    }
  }
  return bestGap;
}

/** Build the full TimelineRowData[] for the library. v1 produces
 *  one row (the video track) containing every ProductionRow as a
 *  clip. M6 will add the voiceover row. */
export function docToTimelineRows(doc: ProductionDoc): TimelineRowData[] {
  const intervals = computeRowIntervals(doc);
  const videoActions: TimelineActionData[] = intervals.map((iv) => {
    const row = doc.rows[iv.rowIndex];
    return {
      id: iv.rowId,
      start: msToSec(iv.startMs),
      end: msToSec(iv.startMs + iv.durationMs),
      effectId: 'video',
      data: {
        rowIndex: iv.rowIndex,
        scriptText: row.script_text ?? '',
        visualType: row.visual_type ?? 'ai_image',
        imageUrl: row.image_url ?? '',
        onScreenText: row.on_screen_text ?? '',
        muted: row.muted === true,
        transitionIn: row.transition_in === 'cross-fade' ? 'cross-fade' : null,
      },
    };
  });
  return [
    { id: 'video', actions: videoActions },
  ];
}

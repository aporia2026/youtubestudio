/**
 * Pacing post-processor — runs after the LLM emits production-doc
 * rows, before the doc lands in `user_history`.
 *
 * Phase 3 of `_plans/2026-06-03-production-doc-flow-stabilization.md`.
 *
 * The plan calls for "FIRST 12 SECONDS = THE HOOK. Every row in the
 * first 12 s must be ≤ 2.5 s." Putting that directive in the LLM
 * prompt helps ~70% of the time. The other 30% — long-winded openers,
 * rows the LLM lazily kept at 4-6 s — slip past unenforced. This
 * module is the belt-and-braces layer: it walks the emitted rows and
 * deterministically splits any opening row over the budget so the
 * hook always lands.
 *
 * Pure: no IO, no logger, no DB. The stage handler that wraps doc
 * generation passes the freshly-generated doc through this function
 * and persists the result. Tested in
 * `tests/post-process-pacing.test.ts`.
 *
 * What the function does NOT do:
 *
 *   - Promote a standalone static-base opening row to motion_collage.
 *     That would require emitting `motion_collage_panel_prompts` from
 *     thin air — a job for the LLM, not a heuristic. Instead we log
 *     a structured warning so the operator sees how often the LLM
 *     ignores the prompt's "no standalone static base in the first
 *     6s" directive; if the rate is meaningful, the next iteration
 *     adds a regenerate-with-stronger-prompt loop.
 *
 *   - Modify rows past the opening window. The "fast" profile's
 *     overall word budget is enforced by the LLM prompt's per-row
 *     ceiling; trying to slice every row across a 5-minute doc would
 *     fragment narration rhythm.
 */

import type { ProductionDoc, ProductionRow } from '../../remotion/utils';

// ─── Constants ──────────────────────────────────────────────────────

/** Hook window in seconds. Rows whose midpoint sits inside this window
 *  are subject to the opening-shot ceiling. 12 s matches the YouTube
 *  data on average retention drop in the first quarter of a short. */
const OPENING_HOOK_SECONDS = 12;

/** Per-row ceiling inside the hook window. Rows over this threshold
 *  are split. 2.5 s is the LLM's stated target for "fast" pace; rows
 *  ≤ 2.5 s pass through untouched. */
const OPENING_MAX_ROW_SECONDS = 2.5;

/** Minimum row duration produced by a split. A row shorter than this
 *  would force the renderer to either truncate audio or over-pad —
 *  either way the row reads as a beat the user can't hear. Splits
 *  that would produce a row under this threshold are skipped. */
const MIN_SPLIT_ROW_SECONDS = 1.0;

// ─── Types ──────────────────────────────────────────────────────────

export interface PostProcessPacingResult {
  doc: ProductionDoc;
  /** Counts of post-processing actions, useful for the stage's
   *  telemetry log. */
  diagnostics: {
    profile: 'standard' | 'fast' | 'very_fast';
    openingRowsExamined: number;
    openingRowsSplit: number;
    openingFirstRowIsStaticBase: boolean;
    rowsAfter: number;
  };
}

// ─── Public entry point ─────────────────────────────────────────────

/**
 * Apply pacing post-processing to a freshly-generated doc. Returns a
 * new doc (input is not mutated) plus diagnostics for the caller's
 * log.
 *
 * Behaviour:
 *
 *   - `pacing_profile === 'standard'` or undefined on a legacy doc:
 *     pass-through. Diagnostics still populate so the caller can
 *     audit how often the "standard" path is taken.
 *
 *   - `pacing_profile === 'fast'` or `'very_fast'`: walk rows whose
 *     window overlaps the first `OPENING_HOOK_SECONDS`. Split any
 *     row over `OPENING_MAX_ROW_SECONDS` into two contiguous rows
 *     by word-count midpoint. Inherit visual fields verbatim on the
 *     split rows.
 *
 * Row splits do NOT cascade — a split row that's still > the ceiling
 * is left at the 2-row split. Beyond 2-way splits the heuristic gets
 * unreliable (sentence boundaries get rare); the LLM prompt is
 * expected to keep rows in a sane range to begin with.
 */
export function applyPacingPostProcess(input: ProductionDoc): PostProcessPacingResult {
  const profile = input.pacing_profile ?? 'standard';
  const rowsInput = input.rows ?? [];

  // Standard / legacy: no transformation.
  if (profile === 'standard') {
    return {
      doc: input,
      diagnostics: {
        profile,
        openingRowsExamined: 0,
        openingRowsSplit: 0,
        openingFirstRowIsStaticBase: false,
        rowsAfter: rowsInput.length,
      },
    };
  }

  // Compute per-row windows. Timecodes look like `"MM:SS - MM:SS"` or
  // `"0:00 - 0:05"`; parseTimecodeRange tolerates both.
  let openingRowsExamined = 0;
  let openingRowsSplit = 0;
  const nextRows: ProductionRow[] = [];
  for (const row of rowsInput) {
    const range = parseTimecodeRange(row.timecode);
    // Out-of-range / malformed timecode → leave the row untouched.
    // We don't want to silently rewrite rows whose timing the LLM
    // had a hard time computing — that's an LLM-quality signal, not
    // a pacing post-process one.
    if (!range) {
      nextRows.push(row);
      continue;
    }
    const { startSec, endSec } = range;
    const duration = Math.max(0, endSec - startSec);

    // Only consider rows whose START falls inside the hook window.
    // A row that BEGINS at 11 s but ENDS at 16 s is still an opening
    // row from the viewer's perspective.
    if (startSec >= OPENING_HOOK_SECONDS) {
      nextRows.push(row);
      continue;
    }

    openingRowsExamined += 1;

    if (duration <= OPENING_MAX_ROW_SECONDS) {
      nextRows.push(row);
      continue;
    }

    // Split candidate: try a word-count midpoint split.
    const split = splitRowByMidpoint(row, startSec, endSec);
    if (split === null) {
      // Split would produce an under-minimum row, OR the row's
      // script text is too short to split usefully. Leave it.
      nextRows.push(row);
      continue;
    }
    openingRowsSplit += 1;
    nextRows.push(split[0]);
    nextRows.push(split[1]);
  }

  // Opening-first-row diagnostic. A standalone static-base in the
  // first 6 s is the LLM ignoring the hook directive — track but
  // don't auto-promote (see module docstring).
  const firstRow = nextRows[0];
  const openingFirstRowIsStaticBase = firstRow
    ? isStandaloneStaticBase(firstRow)
    : false;

  return {
    doc: { ...input, rows: nextRows },
    diagnostics: {
      profile,
      openingRowsExamined,
      openingRowsSplit,
      openingFirstRowIsStaticBase,
      rowsAfter: nextRows.length,
    },
  };
}

// ─── Timecode parsing ───────────────────────────────────────────────

/**
 * Parse a row's `timecode` string into `{ startSec, endSec }`. Accepts:
 *
 *   - `"MM:SS - MM:SS"` (standard)
 *   - `"M:SS - M:SS"`   (single-digit minute)
 *   - Surrounding whitespace
 *   - Any dash variant (`-`, `–`, `—`)
 *
 * Returns `null` on parse failure. We don't throw — a malformed
 * timecode is data the LLM produced and is salvageable downstream.
 *
 * Exported for unit testing.
 */
export function parseTimecodeRange(
  timecode: string | undefined,
): { startSec: number; endSec: number } | null {
  if (!timecode || typeof timecode !== 'string') return null;
  // Split on any dash variant + optional surrounding whitespace.
  const parts = timecode.split(/\s*[-–—]\s*/);
  if (parts.length !== 2) return null;
  const start = parseClockToSeconds(parts[0]);
  const end = parseClockToSeconds(parts[1]);
  if (start === null || end === null) return null;
  if (end < start) return null;
  return { startSec: start, endSec: end };
}

function parseClockToSeconds(clock: string): number | null {
  const trimmed = clock.trim();
  // Accept M:SS, MM:SS, H:MM:SS. Pure-seconds (e.g. "12") also fine.
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const segments = trimmed.split(':').map((s) => Number(s));
  if (segments.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (segments.length === 2) {
    const [m, s] = segments;
    return m * 60 + s;
  }
  if (segments.length === 3) {
    const [h, m, s] = segments;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

/** Inverse of `parseClockToSeconds` — produces a `MM:SS` string with
 *  leading-zero minutes when the value is under one hour. */
function secondsToClock(sec: number): string {
  const rounded = Math.max(0, Math.round(sec));
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatTimecodeRange(startSec: number, endSec: number): string {
  return `${secondsToClock(startSec)} - ${secondsToClock(endSec)}`;
}

// ─── Row splitting ──────────────────────────────────────────────────

/**
 * Split a row at the word-count midpoint of its `script_text`. Both
 * halves inherit every visual field from the original row (same
 * `ai_image_prompt`, `visual_description`, `visual_type`,
 * `motion_beats`, etc.) — only `script_text`, `timecode`, and reset
 * `attempts`/`last_error` (since these are now NEW rows).
 *
 * The text split prefers a sentence boundary near the midpoint; falls
 * back to a word boundary. If the resulting two rows would have under
 * `MIN_SPLIT_ROW_SECONDS` each, returns `null` and the caller leaves
 * the original row.
 *
 * Time is split proportionally to word count — a 60/40 word split
 * gets a 60/40 time split, not 50/50. Keeps narration cadence intact.
 *
 * Exported for unit testing.
 */
export function splitRowByMidpoint(
  row: ProductionRow,
  startSec: number,
  endSec: number,
): [ProductionRow, ProductionRow] | null {
  const text = (row.script_text ?? '').trim();
  if (!text) return null;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 4) return null; // not enough words to split meaningfully

  // Word-count midpoint. Prefer the nearest sentence end (period /
  // question / exclamation / em-dash) within ±25% of the midpoint —
  // gives a more natural break than slicing mid-clause.
  const midIdx = Math.floor(words.length / 2);
  const window = Math.max(1, Math.floor(words.length * 0.25));
  const tryBoundary = (idx: number): boolean => {
    if (idx < 1 || idx >= words.length) return false;
    const prev = words[idx - 1] ?? '';
    return /[.!?…]$/.test(prev);
  };
  let splitIdx = midIdx;
  for (let off = 0; off <= window; off++) {
    if (tryBoundary(midIdx + off)) {
      splitIdx = midIdx + off;
      break;
    }
    if (tryBoundary(midIdx - off)) {
      splitIdx = midIdx - off;
      break;
    }
  }

  const firstWords = words.slice(0, splitIdx);
  const secondWords = words.slice(splitIdx);
  if (firstWords.length === 0 || secondWords.length === 0) return null;

  // Proportional time split.
  const totalDur = endSec - startSec;
  if (totalDur <= 0) return null;
  const firstFrac = firstWords.length / words.length;
  const splitTimeSec = startSec + totalDur * firstFrac;
  const firstDur = splitTimeSec - startSec;
  const secondDur = endSec - splitTimeSec;
  if (firstDur < MIN_SPLIT_ROW_SECONDS || secondDur < MIN_SPLIT_ROW_SECONDS) {
    return null;
  }

  const firstText = firstWords.join(' ');
  const secondText = secondWords.join(' ');

  const baseClone: ProductionRow = {
    ...row,
    // Reset reliability state — these are NEW rows, not retries of
    // the original.
    attempts: 0,
    last_error: null,
  };

  const firstRow: ProductionRow = {
    ...baseClone,
    script_text: firstText,
    timecode: formatTimecodeRange(startSec, splitTimeSec),
  };
  const secondRow: ProductionRow = {
    ...baseClone,
    script_text: secondText,
    timecode: formatTimecodeRange(splitTimeSec, endSec),
  };

  return [firstRow, secondRow];
}

// ─── Standalone static-base detection ───────────────────────────────

/**
 * A "standalone static base" is a row that:
 *   - is NOT a variant (variant_index === 0 or undefined)
 *   - has NO motion content (no shot_kind === 'motion' / 'motion_collage',
 *     no motion_beats)
 *   - has NO real-photo overlay terms
 *   - has NO section title / label
 *
 * Exactly the kind of "long static hold" the user complained about.
 * Exported for unit testing.
 */
export function isStandaloneStaticBase(row: ProductionRow): boolean {
  if ((row.variant_index ?? 0) > 0) return false;
  if (row.shot_kind && row.shot_kind !== 'static') return false;
  if (Array.isArray(row.motion_beats) && row.motion_beats.length > 0) return false;
  if (row.overlay_stock_terms?.trim()) return false;
  if (row.section_title?.trim()) return false;
  return true;
}

/**
 * Voiceover-aligned scene timing — pure helpers.
 *
 * Given a `ProductionDoc`'s per-row script text and a `ForcedAlignmentResponse`
 * from ElevenLabs Forced Alignment, walk the aligner's flat word array and
 * derive a `[startMs, endMs]` interval for every row. The result is fed back
 * into `productionDocToVideoConfig` so every scene transition lands exactly
 * when the corresponding narration line starts — frame-precise sync instead
 * of the estimated-timecode drift the production-doc generator emits.
 *
 * Design follows _plans/2026-05-13-voiceover-aligned-scene-timing.md:
 *   - Word-level alignment (not character-level — rows always end on word
 *     boundaries, so per-character precision adds zero practical value).
 *   - Per-row fallback (not per-doc): a single unalignable row drops back
 *     to its estimated timecode; the rest of the doc stays frame-precise.
 *   - Cursor-based walk with bounded forward / backward resync to absorb
 *     aligner over- and under-segmentation (e.g. "don't" → "don" + "t").
 *
 * This file is pure data in → pure data out. No DB, no fetch, no env
 * variables. The cache + API layer lives in `voiceover-alignment-cache.ts`
 * (Phase 2), and `productionDocToVideoConfig` consumes the output (Phase 3).
 */

import type { ForcedAlignmentResponse, ForcedAlignmentWord } from './elevenlabs';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AlignedRow {
  rowIndex: number;
  /** Frame-rounding is the consumer's job — these are raw milliseconds. */
  startMs: number;
  /** Strictly greater than `startMs` for aligned rows; equal-to-start
   *  is impossible because we extend trailing silence into the last row. */
  endMs: number;
  /** Telemetry + UI hinting. `aligned` = derived from the aligner's
   *  per-word timestamps. `estimated` = fell back to the row's original
   *  timecode (empty row, all-word mismatch, or aligner ran out of
   *  words). */
  source: 'aligned' | 'estimated';
}

export interface AlignRowsInput {
  /** Per-row spoken text. Already passed through `stripProductionMarkers`
   *  by the caller — anything the narrator wouldn't say must be gone
   *  before this point, or the cursor walk desyncs immediately. */
  rowScripts: string[];
  /** Per-row estimated start, in milliseconds. Used when a row can't
   *  be aligned (empty / mismatched). Must be the same length as
   *  `rowScripts`. */
  fallbackStartMs: number[];
  /** Full audio duration in milliseconds. The trailing row's `endMs`
   *  is extended to this value so any tail outro silence is covered. */
  fallbackTotalMs: number;
  /** ElevenLabs Forced Alignment response. Spacing-type tokens are
   *  filtered out by this helper — pass the raw response through. */
  alignment: ForcedAlignmentResponse;
  /** How many words ahead / behind the cursor we'll scan to resync on
   *  a mismatch. Default 3 absorbs typical aligner over-segmentation
   *  ("don't" → "don" + "t") without letting a genuinely bad row drag
   *  the rest of the doc out of sync. */
  fuzzyWindow?: number;
}

// ─── Word normalisation ───────────────────────────────────────────────────────

/**
 * Map fancy Unicode glyphs the script generator sometimes emits onto
 * their ASCII equivalents so they survive the word-comparison strip.
 * Without this, ’ vs ' and — vs - cause spurious mismatches on every
 * other row.
 */
function normaliseUnicode(raw: string): string {
  return raw
    .replace(/[‘’‚‛′]/g, "'")  // single quotes / prime
    .replace(/[“”„‟″]/g, '"')  // double quotes
    .replace(/[–—―−]/g, '-')        // en/em/horizontal dash + minus
    .replace(/…/g, '...')                          // horizontal ellipsis
    .replace(/ /g, ' ');                           // non-breaking space
}

/**
 * Canonical form for word equality. Lowercase, ASCII letters / digits /
 * apostrophe / hyphen only — drops every other character, including
 * the dollar / percent / brackets the aligner sometimes folds into the
 * adjacent token. Exported for tests; not meant for external callers.
 *
 * Pure-punctuation residue (a script token of just "—" or "..." that
 * survives Unicode normalisation as "-" or "...") collapses to the
 * empty string so the cursor walk skips it without consuming an
 * aligner word. Without this, a stray dash in the script kills the
 * alignment of every row that contains one.
 */
export function normaliseWord(raw: string): string {
  const stripped = normaliseUnicode(raw).toLowerCase().replace(/[^a-z0-9'-]/g, '');
  if (/^['-]+$/.test(stripped)) return '';
  return stripped;
}

/**
 * Apostrophe/hyphen-loose equality used inside `tryPrefixMerge` only.
 *
 * Two cases this handles that the strict `normaliseWord` check can't:
 *   - Contractions split by the aligner: `"Don't"` (one script word,
 *     `"don't"` after normalising) vs `["Don", "t"]` (merged into
 *     `"dont"`) — apostrophes stripped both sides.
 *   - Hyphenated compounds the aligner tokenises individually:
 *     `"state-of-the-art"` vs `["state", "of", "the", "art"]` →
 *     `"stateoftheart"` — hyphens stripped both sides.
 *
 * Kept separate from `normaliseWord` so the strict cursor-walk
 * happy path doesn't collapse `"we'll"` onto `"well"` or
 * `"co-op"` onto `"coop"` accidentally.
 */
function looseEqual(a: string, b: string): boolean {
  return a.replace(/['-]/g, '') === b.replace(/['-]/g, '');
}

function looseLength(s: string): number {
  return s.replace(/['-]/g, '').length;
}

/**
 * Tokenise a row's spoken text into the word list the aligner would
 * have produced. Mirrors how `narrator-utils.buildAlignmentScript`
 * tokenises rows for the upstream API call so cursor positions stay
 * in lockstep with what ElevenLabs scored.
 */
function tokeniseRow(scriptText: string): string[] {
  if (!scriptText) return [];
  return normaliseUnicode(scriptText).trim().split(/\s+/).filter(Boolean);
}

/**
 * Filter out non-word tokens (pure whitespace; ElevenLabs `type === 'spacing'`
 * markers). The aligner's word array can interleave these and a naive
 * cursor walk that doesn't drop them desyncs immediately. Identical to
 * the filter `sliceAlignmentToSections` uses, intentionally kept here
 * so the file is self-contained for tests.
 */
function isSpokenWordToken(w: ForcedAlignmentWord): boolean {
  return /\S/.test(w.text);
}

// ─── Frame snapping (consumer convenience) ────────────────────────────────────

/**
 * Round a millisecond value to the nearest frame at the supplied fps.
 * Exposed so the render-side caller can frame-snap aligned timings
 * before stuffing them back into `VideoConfig.shots`. Pure; not used
 * by `alignRowsToWords` itself — the function returns raw ms so
 * downstream tests can assert exact aligner values.
 */
export function snapMsToFrame(ms: number, fps: number): number {
  if (fps <= 0) return ms;
  const frame = Math.round((ms / 1000) * fps);
  return (frame / fps) * 1000;
}

// ─── Cursor-based row→word walk ───────────────────────────────────────────────

/**
 * Try to match one script word against `1..fuzzyWindow+1` consecutive
 * aligner tokens by concatenating their normalised forms. Handles
 * over-segmentation where the aligner split one script word across
 * multiple tokens — `"don't"` → `"don"` + `"t"` is the canonical case.
 *
 * Returns the index of the LAST aligner word consumed (so the caller
 * jumps cursor to `last + 1`), or `-1` when no merge of up to
 * `fuzzyWindow + 1` consecutive tokens reproduces the target.
 *
 * Apostrophe-loose comparison only: stricter normalisation lives on
 * the single-token happy path.
 */
function tryPrefixMerge(
  words: ForcedAlignmentWord[],
  cursor: number,
  target: string,
  fuzzyWindow: number,
): number {
  let merged = '';
  const targetLen = looseLength(target);
  const maxK = Math.min(fuzzyWindow, words.length - cursor - 1);
  for (let k = 0; k <= maxK; k++) {
    merged += normaliseWord(words[cursor + k].text);
    if (looseEqual(merged, target)) return cursor + k;
    // Early-exit: once the loose-stripped merged prefix is strictly
    // longer than the target, no further extension can match.
    if (looseLength(merged) > targetLen) return -1;
  }
  return -1;
}

/**
 * Resync recipe used after prefix-merge fails: try forward look-ahead,
 * then backward look-back, up to `fuzzyWindow` words. Returns the new
 * cursor position (or -1 if no match was found within the window).
 *
 * Forward absorbs aligner-inserted words (e.g. a leading "uh" filler
 * the script doesn't have). Backward absorbs the rare case where the
 * cursor over-advanced on a previous merge.
 */
function resyncCursor(
  words: ForcedAlignmentWord[],
  cursor: number,
  target: string,
  fuzzyWindow: number,
): number {
  for (let k = 1; k <= fuzzyWindow; k++) {
    const idx = cursor + k;
    if (idx >= words.length) break;
    if (normaliseWord(words[idx].text) === target) return idx;
  }
  for (let k = 1; k <= fuzzyWindow; k++) {
    const idx = cursor - k;
    if (idx < 0) break;
    if (normaliseWord(words[idx].text) === target) return idx;
  }
  return -1;
}

/**
 * Derive per-row `[startMs, endMs]` ranges from a ForcedAlignmentResponse.
 *
 * Algorithm — for each row in document order:
 *
 *   1. Tokenise the row's stripped script into words.
 *   2. Empty row (title-card with no narration): emit an `estimated`
 *      span using the row's fallback start + the next row's fallback
 *      start (or `fallbackTotalMs` for the last row). Cursor does NOT
 *      advance — the alignment word stream belongs to the spoken rows
 *      around the title card.
 *   3. Non-empty row: consume `rowWords.length` aligner words from
 *      `cursor`. On each comparison normalise both sides; on a
 *      mismatch try `resyncCursor` (forward look-ahead then backward
 *      look-back, bounded by `fuzzyWindow`). If resync succeeds we
 *      jump the cursor and continue; if it fails entirely the row
 *      drops to its fallback timecode and the cursor still advances
 *      by `rowWords.length` so we don't permanently desync the rest
 *      of the doc.
 *   4. Aligned row's range = `[words[firstIdx].start, words[lastIdx].end] * 1000`.
 *   5. The last aligned row's endMs is stretched to `fallbackTotalMs`
 *      so any tail outro silence is covered by the final shot.
 *
 * Never throws — every failure mode produces an AlignedRow with
 * `source: 'estimated'` and the row's fallback timecode. That property
 * is load-bearing for the render route, which always wants a usable
 * config even if the aligner returned garbage.
 */
export function alignRowsToWords(input: AlignRowsInput): AlignedRow[] {
  const {
    rowScripts,
    fallbackStartMs,
    fallbackTotalMs,
    alignment,
    fuzzyWindow = 3,
  } = input;

  if (rowScripts.length === 0) return [];
  if (rowScripts.length !== fallbackStartMs.length) {
    throw new Error(
      `alignRowsToWords: rowScripts (${rowScripts.length}) and fallbackStartMs (${fallbackStartMs.length}) must be the same length`,
    );
  }

  const words = (alignment.words || []).filter(isSpokenWordToken);
  const rows: AlignedRow[] = [];

  // Pre-compute the per-row fallback span: row i runs from
  // fallbackStartMs[i] to fallbackStartMs[i+1] (or fallbackTotalMs for
  // the last row). Reused for empty / unalignable rows so the doc
  // always has a usable timeline.
  function fallbackEndForRow(i: number): number {
    const nextStart = fallbackStartMs[i + 1];
    const end = nextStart ?? fallbackTotalMs;
    // Defensive: out-of-order timecodes shouldn't crash the walk.
    return end > fallbackStartMs[i] ? end : fallbackStartMs[i] + 1;
  }

  let cursor = 0;
  // Track the last row whose alignment we trust, so we can stretch its
  // endMs to `fallbackTotalMs` even if later rows fell back to estimated.
  let lastAlignedIndex = -1;

  for (let i = 0; i < rowScripts.length; i++) {
    const rowWords = tokeniseRow(rowScripts[i]);

    if (rowWords.length === 0) {
      // Title card with no narration. Keep the row's estimated span;
      // do not move the cursor — the next non-empty row resumes against
      // the same alignment word.
      rows.push({
        rowIndex: i,
        startMs: fallbackStartMs[i],
        endMs: fallbackEndForRow(i),
        source: 'estimated',
      });
      continue;
    }

    // Walk the alignment, consuming one word per script-row word, with
    // resync attempts on mismatches. Record the indices of the first /
    // last words that genuinely matched.
    let firstAlignedIdx = -1;
    let lastAlignedIdx = -1;
    let walkCursor = cursor;
    let mismatched = false;

    for (let w = 0; w < rowWords.length; w++) {
      if (walkCursor >= words.length) {
        // Aligner ran out — partial alignment is unsafe; fall back.
        mismatched = true;
        break;
      }
      const target = normaliseWord(rowWords[w]);
      if (!target) {
        // Row word stripped to empty (e.g. it was pure punctuation
        // after Unicode normalisation). Skip without advancing the
        // aligner cursor.
        continue;
      }
      const here = normaliseWord(words[walkCursor].text);
      if (here === target) {
        if (firstAlignedIdx < 0) firstAlignedIdx = walkCursor;
        lastAlignedIdx = walkCursor;
        walkCursor++;
        continue;
      }
      // Mismatch resolution, in order:
      //   1. Prefix-merge: aligner over-segmented one script word
      //      across multiple tokens ("don't" → "don" + "t").
      //   2. Forward / backward resync: aligner inserted or dropped
      //      a token relative to the script.
      const mergedLastIdx = tryPrefixMerge(words, walkCursor, target, fuzzyWindow);
      if (mergedLastIdx >= 0) {
        if (firstAlignedIdx < 0) firstAlignedIdx = walkCursor;
        lastAlignedIdx = mergedLastIdx;
        walkCursor = mergedLastIdx + 1;
        continue;
      }
      const resynced = resyncCursor(words, walkCursor, target, fuzzyWindow);
      if (resynced < 0) {
        mismatched = true;
        break;
      }
      if (firstAlignedIdx < 0) firstAlignedIdx = resynced;
      lastAlignedIdx = resynced;
      walkCursor = resynced + 1;
    }

    if (mismatched || firstAlignedIdx < 0 || lastAlignedIdx < 0) {
      // Per-row fallback. Cursor still advances by the row's word
      // count so subsequent rows don't permanently desync — the
      // aligner's word stream is in lockstep with the script even
      // if this row's text didn't match.
      rows.push({
        rowIndex: i,
        startMs: fallbackStartMs[i],
        endMs: fallbackEndForRow(i),
        source: 'estimated',
      });
      cursor = Math.min(words.length, cursor + rowWords.length);
      continue;
    }

    const startSec = words[firstAlignedIdx].start;
    const endSec = words[lastAlignedIdx].end;
    rows.push({
      rowIndex: i,
      startMs: Math.round(startSec * 1000),
      endMs: Math.round(endSec * 1000),
      source: 'aligned',
    });
    lastAlignedIndex = i;
    cursor = walkCursor;
  }

  // Stretch the last *aligned* row's endMs to cover tail silence.
  // If the doc ends with an estimated row, no stretch — its endMs
  // already came from fallbackTotalMs anyway.
  if (lastAlignedIndex >= 0) {
    const last = rows[lastAlignedIndex];
    if (last.source === 'aligned' && fallbackTotalMs > last.endMs) {
      last.endMs = fallbackTotalMs;
    }
  }

  return rows;
}

// ─── Levenshtein (script staleness check, Phase 4) ────────────────────────────

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Used by the production-doc UI to decide whether script edits since
 * the last alignment are small enough to auto-absorb (≤5% chars
 * changed → soft re-align), large enough to warrant a background
 * re-alignment (≤20%), or large enough to require re-recording
 * (>20%). See `_plans/2026-05-13-voiceover-aligned-scene-timing.md`
 * "Re-alignment policy" for the thresholds.
 *
 * Iterative two-row implementation — O(m × n) time, O(min(m, n))
 * space. The doc-scale strings we feed it (a few thousand chars at
 * most) finish in well under a frame budget. Long strings are
 * truncated to LEVENSHTEIN_MAX_CHARS so a pathological input can't
 * pin the main thread; the resulting ratio is treated as an
 * underestimate, which biases toward "fewer pills" — preferable to
 * a freeze.
 */
export const LEVENSHTEIN_MAX_CHARS = 8000;

export function levenshteinDistance(a: string, b: string): number {
  const s1 = a.length > LEVENSHTEIN_MAX_CHARS ? a.slice(0, LEVENSHTEIN_MAX_CHARS) : a;
  const s2 = b.length > LEVENSHTEIN_MAX_CHARS ? b.slice(0, LEVENSHTEIN_MAX_CHARS) : b;
  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  // Ensure s2 is the shorter axis to minimise memory.
  const [short, long] = s1.length <= s2.length ? [s1, s2] : [s2, s1];
  const m = short.length;
  const n = long.length;

  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = long.charCodeAt(i - 1) === short.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,     // insertion
        prev[j] + 1,         // deletion
        prev[j - 1] + cost,  // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

/**
 * Edit-distance ratio against the previously-aligned script. Used to
 * pick which Re-alignment policy bucket a doc falls into:
 *   ≤ 0.05  → soft re-align (cursor walk absorbs drift, no API call)
 *   ≤ 0.20  → background re-alignment of the same audio
 *   > 0.20  → re-record needed (estimated timing with warning)
 *
 * Returns 0 when both strings are empty; 1 when only one is empty
 * (treat as "everything changed").
 */
export function scriptDriftRatio(oldScript: string, newScript: string): number {
  const oldLen = oldScript.length;
  const newLen = newScript.length;
  if (oldLen === 0 && newLen === 0) return 0;
  if (oldLen === 0 || newLen === 0) return 1;
  const distance = levenshteinDistance(oldScript, newScript);
  return distance / Math.max(oldLen, newLen);
}

// ─── Canonical script builder ─────────────────────────────────────────────────

/**
 * Build the exact string the aligner sees, given per-row stripped
 * scripts. Mirrors `narrator-utils.buildAlignmentScript`'s join shape
 * (newline-joined, empty rows dropped) so the alignment cache key is
 * stable across narrator-take and production-doc paths.
 *
 * Centralised so the cache layer (Phase 2) and the cursor walk above
 * agree on what "the script" is.
 */
export function buildCanonicalScript(rowScripts: string[]): string {
  return rowScripts
    .map((s) => normaliseUnicode(s).trim())
    .filter((s) => s.length > 0)
    .join('\n');
}

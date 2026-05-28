/**
 * Frame-by-frame mouth-state sequence generation for the
 * `<MouthSwap>` Remotion component (paint_explainer_v1).
 *
 * Two entry points:
 *   - `visemeSequenceFromAlignment`: word-level alignment data drives a
 *     per-frame mouth state. Phoneme-level alignment would be ideal,
 *     but the project's existing ElevenLabs forced alignment is
 *     word-level — so the floor here is "mouth is open while a word
 *     is spoken, mid between words, closed during long pauses." Good
 *     enough to read as "talking" without per-phoneme precision.
 *   - `constantRateVisemeSequence`: fallback for rows without alignment.
 *     Cycles [mid, open] at a configurable mouth-state rate (8 Hz
 *     default — matches the user's verdict on the viability test).
 *
 * Both return `MouthState[]` indexed by frame number. The caller
 * (`<MouthSwap>`) reads `sequence[useCurrentFrame()]` to pick the PNG.
 *
 * Pure: no React, no Remotion, no IO. Safe to import from both server
 * (image-gen pipeline cost telemetry) and the renderer.
 *
 * Plan: §11 of `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 */

export type MouthState = 'closed' | 'mid' | 'open';

/** Word boundary entry produced by the upstream forced aligner.
 *  Mirrors `ForcedAlignmentWord` from `src/lib/elevenlabs.ts` but stays
 *  free of the elevenlabs-specific shape so future aligners (Google
 *  STT, custom) can feed this helper without an adapter layer. */
export interface VisemeWord {
  /** Word text — not used by the algorithm, kept for telemetry /
   *  per-word debugging. Empty string accepted (treated as silence). */
  text: string;
  /** Word start in milliseconds, absolute (same clock as the audio file
   *  the aligner ran against). */
  startMs: number;
  /** Word end in milliseconds, absolute. Must be >= startMs. */
  endMs: number;
}

/** Long-pause threshold. Any silence between words longer than this
 *  collapses to a `closed` mouth instead of `mid`. Reads as the
 *  narrator finishing a thought. 500 ms picked from informal
 *  observation of the Paint Explainer reference videos. */
const LONG_PAUSE_MS = 500;

/**
 * Build the per-frame mouth-state sequence for a single row from the
 * row's slice of the forced-alignment word list.
 *
 * The returned array has exactly `durationFrames` entries (where
 * `durationFrames = round(rowDurationMs / 1000 * fps)`). Each entry is
 * the mouth state for that frame:
 *   - `open`  during any millisecond that falls inside a word's
 *             [startMs, endMs] window
 *   - `mid`   during inter-word silences ≤ LONG_PAUSE_MS
 *   - `closed` during silences > LONG_PAUSE_MS (and before the first
 *             word / after the last word)
 *
 * The `words` array is expected to be ALREADY SLICED to the row's
 * time window — callers should filter the aligner's flat word list
 * against `[rowStartMs, rowStartMs + rowDurationMs)` before calling.
 * Words whose interval extends past the row boundary are clipped at
 * the row edge.
 */
export function visemeSequenceFromAlignment(args: {
  rowStartMs: number;
  rowDurationMs: number;
  words: VisemeWord[];
  fps: number;
}): MouthState[] {
  const { rowStartMs, rowDurationMs, words, fps } = args;
  if (rowDurationMs <= 0 || fps <= 0) return [];

  const totalFrames = Math.max(1, Math.round((rowDurationMs / 1000) * fps));
  const sequence: MouthState[] = new Array(totalFrames);
  const msPerFrame = 1000 / fps;

  // Normalise words: clip to row window, drop empties, sort by startMs.
  const rowEndMs = rowStartMs + rowDurationMs;
  const inRowWords = words
    .map((w) => ({
      startMs: Math.max(w.startMs, rowStartMs),
      endMs: Math.min(w.endMs, rowEndMs),
    }))
    .filter((w) => w.endMs > w.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  for (let i = 0; i < totalFrames; i++) {
    const frameMs = rowStartMs + i * msPerFrame;
    const insideWord = inRowWords.some(
      (w) => frameMs >= w.startMs && frameMs < w.endMs,
    );
    if (insideWord) {
      sequence[i] = 'open';
      continue;
    }
    // Determine pause length surrounding this frame to choose between
    // mid (short pause) and closed (long pause / no narration).
    const prevEnd = lastEndBefore(frameMs, inRowWords);
    const nextStart = firstStartAfter(frameMs, inRowWords);
    const pauseStart = prevEnd ?? rowStartMs;
    const pauseEnd = nextStart ?? rowEndMs;
    const pauseLen = pauseEnd - pauseStart;
    sequence[i] = pauseLen > LONG_PAUSE_MS ? 'closed' : 'mid';
  }

  return sequence;
}

function lastEndBefore(
  ms: number,
  words: Array<{ startMs: number; endMs: number }>,
): number | null {
  let best: number | null = null;
  for (const w of words) {
    if (w.endMs <= ms) {
      if (best === null || w.endMs > best) best = w.endMs;
    }
  }
  return best;
}

function firstStartAfter(
  ms: number,
  words: Array<{ startMs: number; endMs: number }>,
): number | null {
  let best: number | null = null;
  for (const w of words) {
    if (w.startMs > ms) {
      if (best === null || w.startMs < best) best = w.startMs;
    }
  }
  return best;
}

/**
 * Fallback when no alignment data is available — generates a periodic
 * mid↔open cycle at a configurable rate. Output is a `MouthState[]`
 * of length `durationFrames` so callers can use the same indexing as
 * the alignment-driven path.
 *
 * @param rateHz - How many mouth-state changes per second. 8 Hz is the
 *   value the user picked from the 2026-05-28 viability test. Range
 *   clamped to [2, 24] so a stale doc setting can't produce a strobe.
 */
export function constantRateVisemeSequence(args: {
  durationFrames: number;
  fps: number;
  rateHz?: number;
}): MouthState[] {
  const { durationFrames, fps } = args;
  if (durationFrames <= 0 || fps <= 0) return [];
  const rateHz = Math.max(2, Math.min(24, args.rateHz ?? 8));
  const framesPerState = Math.max(1, Math.round(fps / rateHz));

  const sequence: MouthState[] = new Array(durationFrames);
  for (let i = 0; i < durationFrames; i++) {
    const stateIdx = Math.floor(i / framesPerState) % 2;
    sequence[i] = stateIdx === 0 ? 'mid' : 'open';
  }
  return sequence;
}

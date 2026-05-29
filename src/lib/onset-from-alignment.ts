/**
 * Rebase a `label_pop` motion beat's startMs to the actual word's
 * onset in the project's forced-alignment data.
 *
 * Why: the LLM emits `motion_beats[{kind: 'label_pop', payload: {text:
 * "VAQUEROS"}, startMs: 1800}]` based on the row's estimated timecode.
 * But the real audio of "Vaqueros" might fire at 1623 ms or 1947 ms,
 * not exactly 1800. Snapping the label's pop-on to the actual phoneme
 * onset is what makes the label feel synced to the narration instead
 * of floating near it.
 *
 * Pure: no React, no Remotion, no IO. Safe to import from both server
 * and the renderer.
 *
 * Plan: §11 of `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 */

import type { VisemeWord } from './viseme-from-alignment';

export interface OnsetFromAlignmentArgs {
  /** Per-shot word slice (absolute ms from start of audio).
   *  Typically `shot.visemeWords` populated by
   *  `attachPaintExplainerV1VisemeWords` in `src/remotion/utils.ts`. */
  words: VisemeWord[] | undefined;
  /** The label's display text, e.g. "VAQUEROS" or "Donald Kessler".
   *  Comparison is case-insensitive and ignores surrounding punctuation
   *  / whitespace. */
  labelText: string;
  /** The shot's startMs (absolute, same clock as `words[].startMs`).
   *  Used to clip the resolved onset back to a per-shot-relative ms
   *  the renderer expects on motion beats. */
  shotStartMs: number;
  /** Fallback startMs when the label text can't be found in the word
   *  slice — typically the LLM's original `beat.startMs`. */
  fallbackStartMs: number;
}

/**
 * Resolve a label's per-shot startMs from the forced-alignment word
 * slice when possible; fall back to the LLM's estimate otherwise.
 *
 * Match strategy (in order):
 *   1. Multi-word phrase: scan adjacent windows in the word slice
 *      for a full-phrase substring match. Returns the first word's
 *      startMs (relative to shot start).
 *   2. Single-word: case-insensitive substring match against each
 *      word's `text`. Returns the first match's startMs.
 *   3. No match: return the fallback verbatim.
 *
 * The function NEVER returns a negative value — if the resolved
 * absolute startMs is earlier than the shot's startMs (alignment
 * drift / cross-shot word), we clamp to 0.
 */
export function onsetFromAlignment(args: OnsetFromAlignmentArgs): number {
  const { words, labelText, shotStartMs, fallbackStartMs } = args;
  if (!Array.isArray(words) || words.length === 0) return fallbackStartMs;
  const target = normalise(labelText);
  if (target.length === 0) return fallbackStartMs;

  // Pre-normalise the slice once so the inner loops can do cheap
  // string comparisons.
  const normalisedSlice = words.map((w) => ({
    norm: normalise(w.text),
    startMs: w.startMs,
  }));

  // Pattern 1: multi-word phrase. Join consecutive words with a single
  // space and look for the target as a substring.
  const targetTokens = target.split(' ').filter(Boolean);
  if (targetTokens.length > 1) {
    const wordWindow = targetTokens.length;
    for (let i = 0; i + wordWindow <= normalisedSlice.length; i++) {
      const phrase = normalisedSlice
        .slice(i, i + wordWindow)
        .map((w) => w.norm)
        .join(' ');
      if (phrase.includes(target)) {
        const absoluteOnset = normalisedSlice[i].startMs;
        return Math.max(0, absoluteOnset - shotStartMs);
      }
    }
    // Phrase didn't match as a contiguous span — fall through to the
    // single-token loop using the first token. Better to land on
    // *roughly* the right syllable than to fall all the way back to
    // the LLM's blind estimate.
    const firstToken = targetTokens[0];
    for (const w of normalisedSlice) {
      if (w.norm === firstToken || w.norm.includes(firstToken)) {
        return Math.max(0, w.startMs - shotStartMs);
      }
    }
    return fallbackStartMs;
  }

  // Pattern 2: single-token match.
  for (const w of normalisedSlice) {
    if (w.norm === target || w.norm.includes(target)) {
      return Math.max(0, w.startMs - shotStartMs);
    }
  }

  return fallbackStartMs;
}

/** Lowercase + strip surrounding punctuation / extra whitespace.
 *  Internal punctuation (apostrophes, hyphens) is preserved so
 *  "don't" matches "don't" — those frequently are the spoken
 *  surface form. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"()[\]{}…]/g, '') // outer punctuation strip
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
}

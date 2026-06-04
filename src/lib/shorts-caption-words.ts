/**
 * Pure helpers that attach per-word timings to caption chunks and
 * decide which word is "active" at a given playback time.
 *
 * The renderer reads `caption.words` to drive karaoke / per-word
 * highlight effects. When ElevenLabs Scribe alignment is available we
 * snap each word to its measured start/end; when alignment is missing
 * (or its word stream drifted from the chunk text), we fall back to
 * proportional spacing within the chunk so the renderer still has SOME
 * timing to drive the highlight.
 *
 * Kept apart from `shorts-render.ts` so the math is unit-testable
 * without dragging the whole render-config builder into the test.
 *
 * Plan: `_plans/2026-06-04-shorts-caption-word-effects.md`.
 */

import type { ForcedAlignmentResponse } from './elevenlabs';
import type { ShortCaptionChunk } from './shorts-render-types';

/** Normalize a token for fuzzy matching between the script + the
 *  ElevenLabs alignment word stream. Lowercase, strip everything that
 *  isn't a letter/digit. Keeps the comparison robust to punctuation
 *  drift ("Password!" in script vs "password" in alignment). */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

interface AlignWord {
  norm: string;
  startMs: number;
  endMs: number;
}

/** Pre-process the alignment payload into a normalized lookup. Returns
 *  an empty array when alignment is absent/empty so the caller can
 *  bail without a null check. */
function prepareAlignWords(
  alignment: ForcedAlignmentResponse | null | undefined,
): AlignWord[] {
  if (!alignment?.words || alignment.words.length === 0) return [];
  return alignment.words.map((w) => ({
    norm: normalizeForMatch(w.text),
    startMs: Math.max(0, Math.round(w.start * 1000)),
    endMs: Math.max(0, Math.round(w.end * 1000)),
  }));
}

/** Compute per-word boundaries by walking the alignment word stream
 *  against each chunk's text. A small lookahead absorbs minor drift
 *  (e.g. the alignment occasionally splits "don't" into "do" + "n't"
 *  or merges "going to" into "gonna"). */
export function attachWordTimingsToChunks(
  chunks: ShortCaptionChunk[],
  alignment: ForcedAlignmentResponse | null | undefined,
): ShortCaptionChunk[] {
  const alignWords = prepareAlignWords(alignment);
  if (alignWords.length === 0) {
    // No alignment to walk — fall back to proportional spacing within
    // each chunk so the highlight effects still have data.
    return chunks.map((c) => ({ ...c, words: proportionalWordTimings(c) }));
  }

  let cursor = 0;
  const LOOKAHEAD = 4;

  return chunks.map((chunk) => {
    const tokens = chunk.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { ...chunk, words: [] };

    const words: Array<{ text: string; start_ms: number; end_ms: number }> = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const norm = normalizeForMatch(token);
      let matchIdx = -1;
      if (norm.length > 0) {
        // Search a small window forward from the cursor. Drift > LOOKAHEAD
        // suggests the alignment seriously disagrees with the script;
        // we fall through to proportional for this word and keep
        // walking so later words can re-sync.
        const end = Math.min(alignWords.length, cursor + LOOKAHEAD + 1);
        for (let j = cursor; j < end; j++) {
          if (alignWords[j]!.norm === norm) {
            matchIdx = j;
            break;
          }
        }
      }

      if (matchIdx >= 0) {
        const aw = alignWords[matchIdx]!;
        // Clamp to chunk bounds so a slightly-misaligned word doesn't
        // bleed across chunk boundaries (would confuse the active-word
        // lookup).
        const start_ms = Math.max(chunk.start_ms, aw.startMs);
        const end_ms = Math.min(chunk.end_ms, Math.max(start_ms + 1, aw.endMs));
        words.push({ text: token, start_ms, end_ms });
        cursor = matchIdx + 1;
      } else {
        // Proportional fallback for this token only. Use the chunk's
        // duration spread across all tokens so far + remaining.
        const chunkDurMs = Math.max(1, chunk.end_ms - chunk.start_ms);
        const n = tokens.length;
        const start_ms = Math.round(chunk.start_ms + (chunkDurMs * i) / n);
        const end_ms = Math.round(chunk.start_ms + (chunkDurMs * (i + 1)) / n);
        words.push({ text: token, start_ms, end_ms });
      }
    }

    return { ...chunk, words };
  });
}

/** Cheap fallback when there's no alignment: distribute words evenly
 *  across the chunk's window. */
function proportionalWordTimings(
  chunk: ShortCaptionChunk,
): Array<{ text: string; start_ms: number; end_ms: number }> {
  const tokens = chunk.text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const chunkDurMs = Math.max(1, chunk.end_ms - chunk.start_ms);
  return tokens.map((text, i) => ({
    text,
    start_ms: Math.round(chunk.start_ms + (chunkDurMs * i) / tokens.length),
    end_ms: Math.round(chunk.start_ms + (chunkDurMs * (i + 1)) / tokens.length),
  }));
}

/** Returns the index of the word whose [start_ms, end_ms) contains
 *  `elapsedMs`, or `-1` when no word is active (silent gap, before
 *  first word, after last word). */
export function findActiveWordIndex(
  words: ReadonlyArray<{ start_ms: number; end_ms: number }>,
  elapsedMs: number,
): number {
  if (words.length === 0) return -1;
  // Linear scan — chunks have ~3-8 words, binary search isn't worth it.
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (elapsedMs >= w.start_ms && elapsedMs < w.end_ms) return i;
  }
  return -1;
}

/** Resolve where each word sits relative to playback: before the
 *  active word ('spoken'), at the active word ('active'), or after
 *  ('upcoming'). When no word is active (silent gap), returns
 *  'spoken' for words ending before elapsedMs and 'upcoming' for the
 *  rest — this makes karaoke style read as "in the gap between words"
 *  consistently. */
export type WordPosition = 'spoken' | 'active' | 'upcoming';

export function wordPositionAt(
  words: ReadonlyArray<{ start_ms: number; end_ms: number }>,
  elapsedMs: number,
  wordIndex: number,
): WordPosition {
  const w = words[wordIndex];
  if (!w) return 'upcoming';
  if (elapsedMs >= w.end_ms) return 'spoken';
  if (elapsedMs >= w.start_ms) return 'active';
  return 'upcoming';
}

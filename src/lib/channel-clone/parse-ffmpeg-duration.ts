/**
 * Parse the duration line out of `ffmpeg -i <file>` stderr.
 *
 * ffmpeg's "Duration:" emission varies across builds and source files:
 *
 *   Duration: 00:13:18.52, start: 0.000000, bitrate: ...     ← canonical
 *   Duration: 00:13:18.5, start: 0.000000, bitrate: ...      ← single decimal
 *   Duration: 00:13:18, start: ...                            ← no decimal
 *   Duration: 00:13:18.523456, start: ...                     ← extra precision
 *   Duration: N/A, ...                                        ← unknown duration
 *
 * The previous implementation accepted only the two-decimal canonical
 * form, so legitimate uploads that ffmpeg reported with one decimal
 * digit (or whole seconds) silently returned 0 — which then defeated
 * the voice-extract window-fitting guard and the user saw
 * "no usable window found in chosen video — giving up" on perfectly
 * good footage.
 *
 * Pure helper — exported separately so it's unit-testable without a
 * sandbox. The thin runtime call lives in `intake-upload-runner.ts`.
 */

const DURATION_RE = /Duration:\s*(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d+))?/;

export interface ParseFfmpegDurationResult {
  /** Seconds (fractional). Null when no parseable duration was found
   *  (e.g. `Duration: N/A` or the line is missing entirely). */
  seconds: number | null;
  /** The matched substring — surfaced to the diagnostic log so the
   *  next time something weird shows up we see what ffmpeg actually
   *  emitted. */
  matchedText: string | null;
}

/** Parse ffmpeg's stderr blob and pull out the duration in seconds.
 *  Tolerates 1-2 digit hours/minutes/seconds and 0-6 digit fractional
 *  seconds. Returns `seconds: null` when the value is `N/A` or
 *  unparseable so the caller can decide what fallback to apply. */
export function parseFfmpegDuration(stderr: string): ParseFfmpegDurationResult {
  if (typeof stderr !== 'string' || stderr.length === 0) {
    return { seconds: null, matchedText: null };
  }
  // Explicit N/A case — ffmpeg knows it can't say, don't fall through
  // to the regex (it wouldn't match anyway but the diagnostic shape
  // matters).
  const naMatch = /Duration:\s*N\/A/i.exec(stderr);
  if (naMatch) {
    return { seconds: null, matchedText: naMatch[0] };
  }
  const m = DURATION_RE.exec(stderr);
  if (!m) {
    return { seconds: null, matchedText: null };
  }
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return { seconds: null, matchedText: m[0] };
  }
  let fractional = 0;
  if (m[4]) {
    // Treat the fractional segment as decimal-point-aligned regardless
    // of digit count: ".5" → 0.5, ".52" → 0.52, ".523456" → 0.523456.
    fractional = Number(`0.${m[4]}`);
    if (!Number.isFinite(fractional)) fractional = 0;
  }
  return {
    seconds: hours * 3600 + minutes * 60 + seconds + fractional,
    matchedText: m[0],
  };
}

/** Estimate a duration in seconds from a transcript word count using
 *  a moderate speaking pace (150 wpm). Used as a fallback when the
 *  ffmpeg probe can't extract a real duration — the rough number is
 *  enough to unblock voice-extract's window-fitting guard. Returns 0
 *  for non-positive or non-finite inputs. */
export function estimateDurationSecFromWords(wordCount: number): number {
  if (!Number.isFinite(wordCount) || wordCount <= 0) return 0;
  const WORDS_PER_MINUTE = 150;
  return Math.round((wordCount / WORDS_PER_MINUTE) * 60);
}

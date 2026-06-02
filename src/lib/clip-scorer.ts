/**
 * Clip scorer — walks a YouTube transcript and ranks candidate
 * "clippable Short moments" by composite score.
 *
 * Used by:
 *   - Mode A explicit invocation: user picks a channel video, gets the
 *     top-N candidates with timecodes + a YouTube Studio deep link.
 *   - Auto-fan-out: when the user saves a new long-form script with
 *     captions/transcript-equivalent timing data, fire 3 candidates
 *     onto the project + into the global Shorts inbox.
 *
 * Why pure / deterministic for Phase 1:
 *   See `hook-scoring.ts` rationale. The auto-fan-out path fires on
 *   every script save — keeping the scorer deterministic + cheap is
 *   the only way that pays for itself at scale. An AI calibration pass
 *   is a Phase 2 / 2.5 add behind a workspace setting.
 *
 * Composite score (0..1):
 *   - hookScore       (40% weight) — hook-scoring.ts on first 1.5s of caption text.
 *   - payoffScore     (20% weight) — does the candidate's LAST sentence land a
 *                                    visible payoff (resolution / number / reveal)?
 *   - standalone      (20% weight) — does the candidate make sense without prior
 *                                    context? (penalises "that's why" / "as I said"
 *                                    / "the third one is" mid-thought openers.)
 *   - density         (20% weight) — words-per-second close to the WPM sweet spot
 *                                    of 2.0–2.7 wps (≈120–162 WPM). Too slow =
 *                                    boring; too fast = unintelligible.
 *
 * Algorithm:
 *   1. Slide a window over the transcript segments at `STEP_SECONDS`
 *      intervals, accumulating segments until elapsed time crosses
 *      `targetSeconds`.
 *   2. For each window, compute the four sub-scores + composite.
 *   3. Drop windows that are too short (< 0.6 × target) or too long
 *      (> 1.5 × target) — bracket protects against transcript edges.
 *   4. Sort by composite desc, return top-N. Optionally non-overlapping
 *      (the default) to avoid 3 candidates that are 90% the same moment.
 */

import { scoreHook } from './hook-scoring';

export interface ClipScorerSegment {
  /** Caption text for this segment. */
  text: string;
  /** Start time in milliseconds from the source video start. */
  offset_ms: number;
  /** Segment duration in milliseconds. */
  duration_ms: number;
}

export interface ClipCandidate {
  /** Start timecode of the candidate moment (ms). */
  startMs: number;
  /** End timecode of the candidate moment (ms). */
  endMs: number;
  /** Joined transcript text covering the candidate window. */
  text: string;
  /** First ~1.5s of caption text — used to compute hookScore. Cached for UI display. */
  hookText: string;
  /** Composite score, 0..1. */
  score: number;
  /** Hook sub-score (0..1) from hook-scoring.ts. */
  hookScore: number;
  /** Payoff sub-score (0..1). */
  payoffScore: number;
  /** Standalone sub-score (0..1). */
  standaloneScore: number;
  /** Density sub-score (0..1). */
  densityScore: number;
  /** Word count across the window. */
  wordCount: number;
  /** Window duration in seconds (end - start). */
  durationSeconds: number;
}

export interface ScoreClipsOptions {
  /** Target Short length in seconds. Default 45. Clamped to [15, 90]. */
  targetSeconds?: number;
  /** Window step in seconds (how far the slider advances per try). Default 5. */
  stepSeconds?: number;
  /** Maximum candidates to return. Default 5. */
  topN?: number;
  /** If true (default), returned candidates don't overlap each other. */
  nonOverlapping?: boolean;
}

const DEFAULT_TARGET_SECONDS = 45;
const MIN_TARGET_SECONDS = 15;
const MAX_TARGET_SECONDS = 90;
const DEFAULT_STEP_SECONDS = 5;
const DEFAULT_TOP_N = 5;

/** Window length bounds, as a fraction of targetSeconds. */
const MIN_WINDOW_RATIO = 0.6;
const MAX_WINDOW_RATIO = 1.5;

/** Sweet-spot speaking density (words per second). Maps the 120–162 WPM band. */
const DENSITY_LOW = 2.0;
const DENSITY_HIGH = 2.7;

/** Composite weight map. Sum = 1. Tune these together. */
const W_HOOK = 0.4;
const W_PAYOFF = 0.2;
const W_STANDALONE = 0.2;
const W_DENSITY = 0.2;

/** Tokens that mark a "mid-thought" opener — penalise standalone score. */
const MID_THOUGHT_OPENERS = [
  'and ', 'but ', 'so ', 'because ', 'because,', 'as i said', 'like i said',
  'as i mentioned', 'as we said', 'as we mentioned', "that's why",
  'thats why', 'the third', 'the fourth', 'the fifth', 'the second',
  'another reason', 'another one', 'next is', 'next up',
];

/** Tokens / patterns that indicate a payoff. */
const PAYOFF_HITS = [
  'turns out', 'the answer', 'the truth', 'the result', 'the trick',
  'the secret', 'the lesson', 'finally', 'in the end', 'so the',
  "that's why", 'thats why', "here's why", 'heres why', "here's the",
  'heres the', 'because', 'so you', 'so we', 'so they',
];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Slices the first `maxMs` milliseconds of joined segment text — the caller
 *  for the hook score wants the first 1.5s of speech, not the first 1.5s
 *  of the window. */
function takeFirstMs(segments: ClipScorerSegment[], maxMs: number): string {
  if (!segments.length) return '';
  const startMs = segments[0]!.offset_ms;
  const out: string[] = [];
  for (const s of segments) {
    if (s.offset_ms - startMs > maxMs) break;
    out.push(s.text);
  }
  return out.join(' ').trim();
}

/** Scores how "standalone" the window is — does the first sentence
 *  make sense without prior video context? */
function scoreStandalone(firstSentence: string): number {
  const lower = firstSentence.toLowerCase().trim();
  if (!lower) return 0.5;
  for (const opener of MID_THOUGHT_OPENERS) {
    if (lower.startsWith(opener)) return 0.2;
  }
  // Pronoun-only opener ("they said", "she did") gets a softer penalty —
  // could be standalone or could reference a prior subject.
  if (/^(they|he|she|it|this|that)\b/.test(lower)) return 0.5;
  // Strong standalone signals: nominal subject, question, or imperative.
  if (/^(who|what|why|how|when|where|do|does|did|is|are|was|were|can|could)\b/.test(lower))
    return 0.95;
  return 0.75;
}

/** Scores payoff strength of the last sentence. */
function scorePayoff(lastSentence: string): number {
  const lower = lastSentence.toLowerCase().trim();
  if (!lower) return 0;
  let score = 0.4; // neutral floor
  for (const hit of PAYOFF_HITS) {
    if (lower.includes(hit)) {
      score += 0.15;
      break;
    }
  }
  // Concrete number in the payoff sentence = stronger landing.
  if (/\d/.test(lastSentence)) score += 0.10;
  // Strong terminal punctuation (! or ?) = explicit landing intent.
  if (/[!?]$/.test(lastSentence.trim())) score += 0.10;
  return clamp01(score);
}

/** Scores density relative to the 2.0–2.7 wps sweet spot. */
function scoreDensity(wordCount: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  const wps = wordCount / durationSeconds;
  if (wps >= DENSITY_LOW && wps <= DENSITY_HIGH) return 1;
  // Soft falloff outside the band.
  if (wps < DENSITY_LOW) return clamp01(wps / DENSITY_LOW);
  // wps > DENSITY_HIGH → ratio approaches 1 as wps approaches DENSITY_HIGH.
  return clamp01(DENSITY_HIGH / wps);
}

/** Splits joined text into sentences for first/last sentence extraction.
 *  Falls back to the whole string if no terminal punctuation is found. */
function firstAndLastSentence(text: string): { first: string; last: string } {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return { first: text.trim(), last: text.trim() };
  if (sentences.length === 1) return { first: sentences[0]!, last: sentences[0]! };
  return { first: sentences[0]!, last: sentences[sentences.length - 1]! };
}

/** Returns true if the candidate range overlaps any range in `taken`. */
function overlapsAny(
  range: { startMs: number; endMs: number },
  taken: Array<{ startMs: number; endMs: number }>,
): boolean {
  for (const t of taken) {
    if (range.startMs < t.endMs && range.endMs > t.startMs) return true;
  }
  return false;
}

export function scoreClips(
  segments: ClipScorerSegment[],
  opts: ScoreClipsOptions = {},
): ClipCandidate[] {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const targetSecondsRaw = opts.targetSeconds ?? DEFAULT_TARGET_SECONDS;
  const targetSeconds = Math.max(
    MIN_TARGET_SECONDS,
    Math.min(MAX_TARGET_SECONDS, targetSecondsRaw),
  );
  const stepSeconds = Math.max(1, opts.stepSeconds ?? DEFAULT_STEP_SECONDS);
  const topN = Math.max(1, opts.topN ?? DEFAULT_TOP_N);
  const nonOverlapping = opts.nonOverlapping ?? true;

  const targetMs = targetSeconds * 1000;
  const stepMs = stepSeconds * 1000;
  const minMs = targetMs * MIN_WINDOW_RATIO;
  const maxMs = targetMs * MAX_WINDOW_RATIO;

  // Pre-sort segments by offset so the sliding window is stable when callers
  // pass them out-of-order (rare with youtube-transcript, defensive here).
  const sorted = [...segments]
    .filter((s) => Number.isFinite(s.offset_ms) && Number.isFinite(s.duration_ms))
    .sort((a, b) => a.offset_ms - b.offset_ms);
  if (sorted.length === 0) return [];

  const candidates: ClipCandidate[] = [];

  for (let startIdx = 0; startIdx < sorted.length; startIdx++) {
    const startMs = sorted[startIdx]!.offset_ms;
    // Step alignment — skip windows that don't start near a step boundary
    // (reduces the candidate explosion on long transcripts; the relative
    // ranking is unaffected because hits cluster around obvious moments).
    if (startIdx > 0 && (startMs - sorted[0]!.offset_ms) % stepMs !== 0) {
      // Allow the first non-aligned start near each step.
      const offsetFromStep = (startMs - sorted[0]!.offset_ms) % stepMs;
      if (offsetFromStep > stepMs / 2) continue;
    }

    // Accumulate segments until the window exceeds targetMs.
    const windowSegs: ClipScorerSegment[] = [];
    let endMs = startMs;
    for (let j = startIdx; j < sorted.length; j++) {
      const seg = sorted[j]!;
      const segEnd = seg.offset_ms + seg.duration_ms;
      if (segEnd - startMs > maxMs) break;
      windowSegs.push(seg);
      endMs = segEnd;
      if (segEnd - startMs >= targetMs) break;
    }

    const spanMs = endMs - startMs;
    if (spanMs < minMs || spanMs > maxMs) continue;
    if (windowSegs.length === 0) continue;

    const text = windowSegs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const wordCount = countWords(text);
    const durationSeconds = spanMs / 1000;

    const hookText = takeFirstMs(windowSegs, 1500);
    const hookScore = scoreHook(hookText).score;
    const { first, last } = firstAndLastSentence(text);
    const standaloneScore = scoreStandalone(first);
    const payoffScore = scorePayoff(last);
    const densityScore = scoreDensity(wordCount, durationSeconds);

    const composite =
      W_HOOK * hookScore +
      W_PAYOFF * payoffScore +
      W_STANDALONE * standaloneScore +
      W_DENSITY * densityScore;

    candidates.push({
      startMs,
      endMs,
      text,
      hookText,
      score: Number(clamp01(composite).toFixed(3)),
      hookScore: Number(hookScore.toFixed(3)),
      payoffScore: Number(payoffScore.toFixed(3)),
      standaloneScore: Number(standaloneScore.toFixed(3)),
      densityScore: Number(densityScore.toFixed(3)),
      wordCount,
      durationSeconds: Number(durationSeconds.toFixed(1)),
    });
  }

  // Rank desc.
  candidates.sort((a, b) => b.score - a.score);

  if (!nonOverlapping) return candidates.slice(0, topN);

  // Greedy non-overlapping pick.
  const picked: ClipCandidate[] = [];
  for (const c of candidates) {
    if (picked.length >= topN) break;
    if (overlapsAny(c, picked)) continue;
    picked.push(c);
  }
  return picked;
}

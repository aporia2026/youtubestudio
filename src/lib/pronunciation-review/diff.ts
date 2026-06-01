/**
 * Word-level diff between the script and Whisper's recognized words.
 *
 * Pure module — no DB, no network, no Node-only APIs. Easy to unit-
 * test in isolation. The orchestrator in `./run.ts` calls
 * `diffScriptVsWhisper` after Whisper completes and the candidate
 * generator in `./candidates.ts` consumes the result.
 *
 * Algorithm: classic Needleman-Wunsch over normalized word tokens
 * (lowercased, punctuation-stripped, contractions kept whole). Linear
 * gap penalty, costs:
 *   match      = 0
 *   substitute = 1
 *   indel      = 1
 *
 * For typical narrator audio the matrix stays manageable — a 14-min
 * narration with ~1,800 script words and ~1,800 Whisper words is
 * 3.2 M cells × ~50 ns per cell ≈ 160 ms on a modern CPU. Pre-filtering
 * by sentence chunks isn't necessary at this scale; if a future use
 * case pushes past 5,000 words we can chunk by paragraph boundaries
 * later.
 *
 * Traceback reconstructs the alignment as an array of `DiffOp`s in
 * left-to-right order. Each op records the script position
 * (`scriptIndex`) and/or the Whisper position (`whisperIndex`) so the
 * candidate generator can map a flag back to either the canonical
 * script word (the reviewer's reading surface) or Whisper's timestamp
 * (when the script has no anchor for it).
 */

export interface DiffWord {
  /** Raw token as it appears in the script or Whisper output (kept for
   *  display — not lowercased). */
  text: string;
  /** Timestamp metadata, only present for Whisper words. */
  startSec?: number;
  endSec?: number;
}

export type DiffOpKind =
  /** Same normalized word at corresponding positions. */
  | 'match'
  /** Different words at corresponding positions. */
  | 'substitute'
  /** Script has a word, Whisper missed it. */
  | 'omit'
  /** Whisper has a word, script doesn't. */
  | 'insert';

export interface DiffOp {
  kind: DiffOpKind;
  /** Position in the SCRIPT word array. Present for match, substitute,
   *  omit. Absent for insert (where the script has nothing). */
  scriptIndex?: number;
  /** Position in the WHISPER word array. Present for match, substitute,
   *  insert. Absent for omit (where Whisper has nothing). */
  whisperIndex?: number;
  /** Raw script word (for display). */
  scriptWord?: string;
  /** Raw Whisper word (for display). */
  whisperWord?: string;
  /** Whisper start timestamp, if available. For `omit` we copy the
   *  surrounding whisper word's timestamp so the flag can still be
   *  located in the audio. */
  startSec?: number;
  endSec?: number;
}

export interface DiffResult {
  ops: DiffOp[];
  /** Summary counts — handy for logs + the smoke test report. */
  matches: number;
  substitutions: number;
  omissions: number;
  insertions: number;
}

/**
 * Normalize a word for comparison. Lowercase, strip surrounding
 * punctuation (keeps internal apostrophes for contractions like
 * "don't"), collapse internal whitespace. Two words compare equal when
 * their normalized forms are byte-identical.
 *
 * Acronyms are preserved as-is in the comparison — `WPA` normalizes to
 * `wpa` and Whisper's transcribed "WPA" or "w p a" will only match the
 * collapsed form. This is intentional: an acronym-vs-letter-sequence
 * mismatch is a real script deviation worth surfacing.
 */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFKC')
    // Strip leading + trailing punctuation but keep internal characters
    // so "don't", "u.s.", and "co-op" all stay distinguishable.
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

/**
 * Tokenize a script string into a normalized array of words. Strips
 * empty tokens and discards bracket-tagged production markers like
 * `[pause]` or `[laughs]` that the canonical script may still carry.
 * Returns the original casing for display, plus the normalized form
 * for comparison.
 */
export function tokenizeScript(script: string): DiffWord[] {
  // Drop bracket-tagged ElevenLabs v3 audio tags so they don't get
  // counted as script words the narrator was supposed to read.
  const cleaned = script.replace(/\[[^\]]+\]/g, ' ');
  return cleaned
    .split(/\s+/)
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .filter((raw) => normalizeWord(raw).length > 0)
    .map((raw) => ({ text: raw }));
}

const COST_MATCH = 0;
const COST_SUB = 1;
const COST_INDEL = 1;

/**
 * Align the script word array against Whisper's word array.
 *
 * Returns the trace of operations needed to transform script into
 * whisper (in NW parlance: edit script). Each op preserves enough
 * context (raw words + timestamps) that the candidate generator
 * doesn't need to re-look-up by index.
 */
export function diffScriptVsWhisper(
  scriptWords: ReadonlyArray<DiffWord>,
  whisperWords: ReadonlyArray<DiffWord>,
): DiffResult {
  const n = scriptWords.length;
  const m = whisperWords.length;

  // Edge cases: one side empty → all indels.
  if (n === 0 && m === 0) {
    return { ops: [], matches: 0, substitutions: 0, omissions: 0, insertions: 0 };
  }
  if (n === 0) {
    const ops: DiffOp[] = whisperWords.map((w, j) => ({
      kind: 'insert',
      whisperIndex: j,
      whisperWord: w.text,
      startSec: w.startSec,
      endSec: w.endSec,
    }));
    return { ops, matches: 0, substitutions: 0, omissions: 0, insertions: m };
  }
  if (m === 0) {
    const ops: DiffOp[] = scriptWords.map((w, i) => ({
      kind: 'omit',
      scriptIndex: i,
      scriptWord: w.text,
    }));
    return { ops, matches: 0, substitutions: 0, omissions: n, insertions: 0 };
  }

  // dp[i][j] = minimal cost to align script[0..i) with whisper[0..j).
  // Allocate as Int32Array for cache-friendliness — costs fit in 32
  // bits easily (max possible = max(n, m) * COST_INDEL).
  const stride = m + 1;
  const dp = new Int32Array((n + 1) * stride);

  for (let i = 0; i <= n; i++) dp[i * stride] = i * COST_INDEL;
  for (let j = 0; j <= m; j++) dp[j] = j * COST_INDEL;

  // Pre-normalize both sides once — saves O(n*m) re-normalizations
  // inside the inner loop.
  const scriptNorm = scriptWords.map((w) => normalizeWord(w.text));
  const whisperNorm = whisperWords.map((w) => normalizeWord(w.text));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const subCost =
        scriptNorm[i - 1] === whisperNorm[j - 1] ? COST_MATCH : COST_SUB;
      const sub = dp[(i - 1) * stride + (j - 1)] + subCost;
      const del = dp[(i - 1) * stride + j] + COST_INDEL;
      const ins = dp[i * stride + (j - 1)] + COST_INDEL;
      dp[i * stride + j] = Math.min(sub, del, ins);
    }
  }

  // Traceback. We prefer match → substitute → omit → insert when
  // costs tie, which keeps the resulting trace stable and easy to read.
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  let matches = 0;
  let substitutions = 0;
  let omissions = 0;
  let insertions = 0;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const isMatch = scriptNorm[i - 1] === whisperNorm[j - 1];
      const subStep = isMatch ? COST_MATCH : COST_SUB;
      if (dp[i * stride + j] === dp[(i - 1) * stride + (j - 1)] + subStep) {
        const sw = scriptWords[i - 1];
        const ww = whisperWords[j - 1];
        if (isMatch) {
          matches++;
          ops.push({
            kind: 'match',
            scriptIndex: i - 1,
            whisperIndex: j - 1,
            scriptWord: sw.text,
            whisperWord: ww.text,
            startSec: ww.startSec,
            endSec: ww.endSec,
          });
        } else {
          substitutions++;
          ops.push({
            kind: 'substitute',
            scriptIndex: i - 1,
            whisperIndex: j - 1,
            scriptWord: sw.text,
            whisperWord: ww.text,
            startSec: ww.startSec,
            endSec: ww.endSec,
          });
        }
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dp[i * stride + j] === dp[(i - 1) * stride + j] + COST_INDEL) {
      const sw = scriptWords[i - 1];
      omissions++;
      ops.push({
        kind: 'omit',
        scriptIndex: i - 1,
        scriptWord: sw.text,
      });
      i--;
      continue;
    }
    // j > 0 case — insertion. Guaranteed reachable because the loop
    // condition is `i > 0 || j > 0` and the two if-branches above
    // cover the only other ways to make progress.
    const ww = whisperWords[j - 1];
    insertions++;
    ops.push({
      kind: 'insert',
      whisperIndex: j - 1,
      whisperWord: ww.text,
      startSec: ww.startSec,
      endSec: ww.endSec,
    });
    j--;
  }

  ops.reverse();

  // Backfill timestamps on `omit` ops from the nearest neighbor's
  // start time so the candidate generator can still locate the
  // omission in the audio (otherwise a Gemini judge call has nothing
  // to slice). Walk left → right with a running cursor; on omit,
  // borrow the previous op's endSec (or the next op's startSec if
  // we're at the head).
  let cursor = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.startSec !== undefined) cursor = op.startSec;
    if (op.kind === 'omit' && op.startSec === undefined) {
      op.startSec = cursor;
      op.endSec = cursor;
    }
  }

  return { ops, matches, substitutions, omissions, insertions };
}

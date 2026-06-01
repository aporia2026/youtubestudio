/**
 * Candidate generation for the pronunciation-review pipeline.
 *
 * Pure module — no DB, no network, no Node-only APIs.
 *
 * Takes the output of `diffScriptVsWhisper` plus the original script
 * word array and produces a deduped list of `Candidate`s for the
 * Gemini judge. A candidate is a position in the audio + script
 * worth spending a Gemini call on.
 *
 * Two sources of candidates merge here:
 *
 *   1. **Diff candidates** — every `substitute`, `omit`, or `insert`
 *      op from the diff is a candidate (the narrator said something
 *      different from the script).
 *   2. **Tricky-word candidates** — even when the diff says match,
 *      Whisper may have transcribed a proper noun correctly while
 *      the narrator pronounced it wrong (`Viehböck` → "Vee-bock").
 *      For words the script flags as tricky (proper nouns, acronyms,
 *      non-ASCII, etc.) we emit an additional candidate so the judge
 *      can listen to the pronunciation.
 *
 * Dedupe: candidates within a 2-second window of each other collapse
 * to one. This bounds the Gemini cost on bursty regions (a narrator
 * stumbling through a sentence shouldn't generate 8 separate flags)
 * and keeps the visual noise level low.
 *
 * Hard cap: at most `MAX_CANDIDATES` (60) candidates per take. If the
 * raw list exceeds that, we keep the highest-priority subset (diff
 * over tricky-word) and truncate the rest with a warning the caller
 * can log. This is a backstop against pathological inputs (e.g. a
 * narrator who read a completely different script) and the orchestrator
 * should treat truncation as a soft warning, not a failure.
 */

import type { DiffOp, DiffResult, DiffWord } from './diff';
import { normalizeWord } from './diff';

/** Maximum candidates passed to the Gemini judge per take. Caps both
 *  cost (~$0.018 per 60 candidates) and Vercel function wall-clock
 *  (~30s for 60 candidates at 5-way parallel @ 2.5 s/call). */
export const MAX_CANDIDATES = 60;

/** Two candidates within this many seconds collapse to one. Tunable —
 *  smaller = more flags, larger = fewer-but-richer flags. */
export const DEDUPE_WINDOW_SEC = 2;

export type CandidateKind =
  | 'substitution'
  | 'omission'
  | 'insertion'
  | 'tricky_word';

export interface Candidate {
  /** Why this candidate exists — surfaces in the Gemini prompt as
   *  a hint about what the judge should look for. */
  kind: CandidateKind;
  /** Position in the SCRIPT word array. May be -1 for pure
   *  insertions (Whisper word with no script counterpart). */
  scriptIndex: number;
  /** Position in the WHISPER word array. -1 for omissions. */
  whisperIndex: number;
  /** Audio window to slice for the judge. End-start is typically
   *  0.3 – 1.5 s. We pad in the slicer; this is the raw word range. */
  startSec: number;
  endSec: number;
  /** Raw script word as it appears in the script (for prompt context).
   *  Empty string for pure insertions. */
  scriptWord: string;
  /** Raw Whisper word (for prompt context). Empty string for
   *  omissions. */
  whisperWord: string;
}

export interface CandidateGenerationResult {
  candidates: Candidate[];
  /** Count of candidates dropped by the 2-sec dedupe window. Logged
   *  for observability; not surfaced to the user. */
  droppedByDedupe: number;
  /** Count of candidates dropped by the MAX_CANDIDATES cap. Surfaces
   *  as a soft warning in the UI when > 0. */
  droppedByCap: number;
}

/**
 * Heuristic test for "tricky" words — script words that warrant a
 * pronunciation check even when Whisper recognized them correctly.
 *
 * Rules (any one triggers true):
 *
 *   • Contains a non-ASCII letter — `Viehböck`, `naïve`, `résumé`.
 *   • Acronym — ≥2 consecutive uppercase letters, possibly with dots
 *     (`WPA`, `W.P.A.`, `NASA`).
 *   • Capitalized mid-sentence — proper-noun heuristic. False
 *     positives at sentence-start are eliminated by the caller, which
 *     skips the first word of each sentence.
 *   • Long word with non-English digraph — ≥10 chars and contains
 *     `qx`, `zh`, `sch`, `kh`, `tz`, or 3+ consonants in a row
 *     anywhere. Catches a lot of non-English proper nouns
 *     (`Schopenhauer`, `Khrushchev`).
 *
 * Returns true if the word is tricky. Pure. Case-sensitive on the
 * raw `text` (the casing IS the signal for the capitalization rules).
 */
export function isTrickyWord(text: string): boolean {
  if (!text) return false;

  // Non-ASCII letter? Most reliable signal.
  if (/[^\x00-\x7F]/.test(text)) return true;

  // Acronym: 2+ consecutive uppercase letters, allowing dots between.
  // Dots are stripped first so `W.P.A.` collapses to `WPA`.
  const stripped = text.replace(/[.\-_]/g, '');
  if (/[A-Z]{2,}/.test(stripped)) return true;

  // Capitalized mid-sentence — caller is responsible for skipping the
  // first word of each sentence. Here we treat any leading-cap word
  // ≥ 4 chars as tricky. Length filter weeds out common short words
  // like "I" and one-letter sentence-starters that slip through.
  if (/^[A-Z][a-z]+/.test(text) && text.length >= 4) return true;

  // Long-word non-English digraph heuristic.
  if (text.length >= 10) {
    const lower = text.toLowerCase();
    if (/qx|zh|kh|tz|sch/.test(lower)) return true;
    if (/[bcdfghjklmnpqrstvwxz]{3,}/.test(lower)) return true;
  }

  return false;
}

/**
 * Sentence-start detection — caller wraps the script in this so the
 * mid-sentence capital heuristic doesn't fire on the first word of
 * every sentence. Returns a Set of script indices where the word is
 * the first word of a sentence.
 *
 * Sentence boundary = previous word ends with `.`, `!`, `?` (the
 * common terminators). The first word of the script is always a
 * sentence start.
 */
export function sentenceStartIndices(scriptWords: ReadonlyArray<DiffWord>): Set<number> {
  const starts = new Set<number>();
  if (scriptWords.length === 0) return starts;
  starts.add(0);
  for (let i = 1; i < scriptWords.length; i++) {
    const prev = scriptWords[i - 1].text;
    if (/[.!?]$/.test(prev)) starts.add(i);
  }
  return starts;
}

/**
 * Main entry. Walks the diff trace + the script word array and
 * produces the candidate list. Order: diff-derived candidates first
 * (in audio-time order), then tricky-word candidates appended in
 * script order, then sort merge by `startSec`, then dedupe by
 * 2-second window, then cap at MAX_CANDIDATES.
 *
 * Stable across re-runs: the same input produces the same output.
 * No randomness, no Math.random.
 */
export function selectCandidates(
  diff: DiffResult,
  scriptWords: ReadonlyArray<DiffWord>,
): CandidateGenerationResult {
  const raw: Candidate[] = [];

  // ── Diff-derived candidates ────────────────────────────────────────
  for (const op of diff.ops) {
    const candidate = diffOpToCandidate(op);
    if (candidate) raw.push(candidate);
  }

  // ── Tricky-word candidates ─────────────────────────────────────────
  // Build an index: scriptIndex → diff op that touches it (match or
  // substitute). Used to pull the Whisper timing for tricky-word
  // candidates that the diff says matched.
  const opByScriptIndex = new Map<number, DiffOp>();
  for (const op of diff.ops) {
    if (op.scriptIndex !== undefined) {
      opByScriptIndex.set(op.scriptIndex, op);
    }
  }

  const sentenceStarts = sentenceStartIndices(scriptWords);

  for (let i = 0; i < scriptWords.length; i++) {
    // Skip first-word-of-sentence for the capitalization rule.
    if (sentenceStarts.has(i)) continue;
    const sw = scriptWords[i];
    if (!isTrickyWord(sw.text)) continue;

    const op = opByScriptIndex.get(i);
    // If the diff already substituted this word, the diff candidate
    // already covers it — don't duplicate.
    if (op && op.kind === 'substitute') continue;
    // If the diff omitted it, the diff candidate already covers it.
    if (op && op.kind === 'omit') continue;

    // Pull the audio window from the matched op's Whisper timing.
    // Fall back to scriptIndex-proportional estimate if (somehow) the
    // op has no timing — this would only happen for pathological
    // diffs and the resulting flag would be located approximately.
    let startSec: number | undefined;
    let endSec: number | undefined;
    let whisperWord = '';
    if (op?.kind === 'match') {
      startSec = op.startSec;
      endSec = op.endSec;
      whisperWord = op.whisperWord ?? '';
    }
    if (startSec === undefined || endSec === undefined) continue;

    raw.push({
      kind: 'tricky_word',
      scriptIndex: i,
      whisperIndex: op?.whisperIndex ?? -1,
      startSec,
      endSec,
      scriptWord: sw.text,
      whisperWord,
    });
  }

  // ── Sort by audio time, then dedupe within DEDUPE_WINDOW_SEC ───────
  raw.sort((a, b) => a.startSec - b.startSec);

  const deduped: Candidate[] = [];
  let droppedByDedupe = 0;
  for (const c of raw) {
    const last = deduped[deduped.length - 1];
    if (last && c.startSec - last.startSec < DEDUPE_WINDOW_SEC) {
      // Same-window collision. Keep the higher-priority kind so a
      // substitution doesn't get masked by a tricky-word match.
      if (kindPriority(c.kind) > kindPriority(last.kind)) {
        deduped[deduped.length - 1] = c;
      }
      droppedByDedupe++;
      continue;
    }
    deduped.push(c);
  }

  // ── Hard cap ───────────────────────────────────────────────────────
  let droppedByCap = 0;
  let final = deduped;
  if (deduped.length > MAX_CANDIDATES) {
    // Sort by priority then by audio time so the kept set covers the
    // highest-value candidates first. Within priority, keep the
    // earlier ones (gives a more even temporal distribution than
    // chopping from the tail).
    const ranked = [...deduped].sort((a, b) => {
      const pa = kindPriority(a.kind);
      const pb = kindPriority(b.kind);
      if (pa !== pb) return pb - pa;
      return a.startSec - b.startSec;
    });
    final = ranked.slice(0, MAX_CANDIDATES).sort((a, b) => a.startSec - b.startSec);
    droppedByCap = deduped.length - MAX_CANDIDATES;
  }

  return { candidates: final, droppedByDedupe, droppedByCap };
}

/**
 * Higher = more important. Drives both the dedupe collision resolution
 * (which candidate wins in the same 2-sec window) and the over-cap
 * truncation (which candidates survive the MAX_CANDIDATES cut).
 *
 * Ranking rationale:
 *   - substitution > omission > insertion: substitutions are the most
 *     visible deviation type (wrong word in the same slot); insertions
 *     are often filler words like "um" that the reviewer doesn't care
 *     about as much.
 *   - tricky_word ranks last because diff candidates already carry
 *     hard evidence of deviation, while tricky-word is a heuristic
 *     pronunciation check that the judge may well reject.
 */
function kindPriority(kind: CandidateKind): number {
  switch (kind) {
    case 'substitution':
      return 4;
    case 'omission':
      return 3;
    case 'insertion':
      return 2;
    case 'tricky_word':
      return 1;
  }
}

function diffOpToCandidate(op: DiffOp): Candidate | null {
  // Skip matches — they're handled by the tricky-word pass.
  if (op.kind === 'match') return null;

  if (op.kind === 'substitute') {
    if (op.startSec === undefined || op.endSec === undefined) return null;
    return {
      kind: 'substitution',
      scriptIndex: op.scriptIndex ?? -1,
      whisperIndex: op.whisperIndex ?? -1,
      startSec: op.startSec,
      endSec: op.endSec,
      scriptWord: op.scriptWord ?? '',
      whisperWord: op.whisperWord ?? '',
    };
  }
  if (op.kind === 'omit') {
    if (op.startSec === undefined || op.endSec === undefined) return null;
    return {
      kind: 'omission',
      scriptIndex: op.scriptIndex ?? -1,
      whisperIndex: -1,
      startSec: op.startSec,
      endSec: op.endSec,
      scriptWord: op.scriptWord ?? '',
      whisperWord: '',
    };
  }
  // insert
  if (op.startSec === undefined || op.endSec === undefined) return null;
  return {
    kind: 'insertion',
    scriptIndex: -1,
    whisperIndex: op.whisperIndex ?? -1,
    startSec: op.startSec,
    endSec: op.endSec,
    scriptWord: '',
    whisperWord: op.whisperWord ?? '',
  };
}

// Re-export for callers that need the normalize helper.
export { normalizeWord };

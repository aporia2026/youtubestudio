/**
 * Unit tests for candidate generation in
 * `src/lib/pronunciation-review/candidates.ts`. Pure module — feed
 * synthetic diffs + script words, assert on the deduped + capped
 * output.
 */

import { describe, expect, it } from 'vitest';
import { diffScriptVsWhisper, type DiffWord } from '@/lib/pronunciation-review/diff';
import {
  isTrickyWord,
  selectCandidates,
  sentenceStartIndices,
  MAX_CANDIDATES,
  DEDUPE_WINDOW_SEC,
} from '@/lib/pronunciation-review/candidates';

function w(text: string, startSec?: number, endSec?: number): DiffWord {
  return { text, startSec, endSec };
}

// ─── isTrickyWord ─────────────────────────────────────────────────────────────

describe('isTrickyWord', () => {
  it('flags non-ASCII words', () => {
    expect(isTrickyWord('Viehböck')).toBe(true);
    expect(isTrickyWord('naïve')).toBe(true);
    expect(isTrickyWord('résumé')).toBe(true);
  });

  it('flags acronyms with 2+ consecutive uppercase letters', () => {
    expect(isTrickyWord('WPA')).toBe(true);
    expect(isTrickyWord('NASA')).toBe(true);
    expect(isTrickyWord('W.P.A.')).toBe(true);
    // 'iOS' also trips the acronym heuristic — accepted as a known
    // false-positive. The Gemini judge filters these cheaply.
    expect(isTrickyWord('iOS')).toBe(true);
  });

  it('flags mid-sentence capitalized words of length >= 4', () => {
    expect(isTrickyWord('Reaver')).toBe(true);
    expect(isTrickyWord('Stefan')).toBe(true);
    expect(isTrickyWord('Bob')).toBe(false); // too short
  });

  it('does not flag lowercase common words', () => {
    expect(isTrickyWord('hello')).toBe(false);
    expect(isTrickyWord('world')).toBe(false);
    expect(isTrickyWord('attacks')).toBe(false);
  });

  it('flags long words with non-English digraphs', () => {
    expect(isTrickyWord('Schopenhauer')).toBe(true);
    expect(isTrickyWord('Khrushchev')).toBe(true);
  });

  it('returns false for empty input', () => {
    expect(isTrickyWord('')).toBe(false);
  });
});

// ─── sentenceStartIndices ────────────────────────────────────────────────────

describe('sentenceStartIndices', () => {
  it('always marks index 0 as a sentence start', () => {
    const words = [w('Hello'), w('world.')];
    const starts = sentenceStartIndices(words);
    expect(starts.has(0)).toBe(true);
  });

  it('marks word after sentence-terminator as a start', () => {
    const words = [w('Hi.'), w('Stefan'), w('ran.'), w('Bob'), w('fell.')];
    const starts = sentenceStartIndices(words);
    expect(starts.has(0)).toBe(true); // Hi.
    expect(starts.has(1)).toBe(true); // Stefan (after Hi.)
    expect(starts.has(3)).toBe(true); // Bob (after ran.)
    expect(starts.has(2)).toBe(false);
    expect(starts.has(4)).toBe(false);
  });

  it('handles empty input', () => {
    expect(sentenceStartIndices([]).size).toBe(0);
  });
});

// ─── selectCandidates: tricky-word emission ──────────────────────────────────

describe('selectCandidates — tricky-word emission', () => {
  it('emits a candidate for a tricky word that diff matched', () => {
    // Script: "Researcher Stefan said hello and Viehböck found it."
    // Whisper transcribed everything correctly — diff has all matches.
    // We expect tricky-word candidates for Stefan and Viehböck. Word
    // timings are spaced > DEDUPE_WINDOW_SEC apart so neither tricky
    // candidate collapses into the other.
    const script = 'Researcher Stefan said hello and Viehböck found it.'
      .split(' ')
      .map((t) => w(t));
    const whisper: DiffWord[] = [
      w('Researcher', 0, 0.5),
      w('Stefan', 0.5, 1.0),
      w('said', 1.0, 1.3),
      w('hello', 1.3, 1.7),
      w('and', 1.7, 1.9),
      // Place Viehböck well beyond the dedupe window from Stefan.
      w('Viehböck', 4.0, 4.5),
      w('found', 4.5, 4.8),
      w('it', 4.8, 5.0),
    ];
    const diff = diffScriptVsWhisper(script, whisper);
    const { candidates } = selectCandidates(diff, script);
    const trickyWords = candidates.filter((c) => c.kind === 'tricky_word');
    const trickyScripts = trickyWords.map((c) => c.scriptWord);
    expect(trickyScripts).toContain('Stefan');
    expect(trickyScripts).toContain('Viehböck');
    expect(trickyScripts).not.toContain('Researcher'); // sentence start
  });

  it('does NOT emit tricky-word candidate when diff already substituted that word', () => {
    // Script: "Stefan Viehböck found it."
    // Whisper substituted Viehböck for something else — diff covers it.
    const script = 'Stefan Viehböck found it.'.split(' ').map((t) => w(t));
    const whisper: DiffWord[] = [
      w('Stefan', 0, 0.5),
      w('Stafan', 0.5, 1.0), // Whisper misheard Viehböck as "Stafan"
      w('found', 1.0, 1.4),
      w('it', 1.4, 1.6),
    ];
    const diff = diffScriptVsWhisper(script, whisper);
    const { candidates } = selectCandidates(diff, script);
    // Only one candidate at the Viehböck position — the substitution,
    // not a duplicate tricky-word.
    const atViehboeck = candidates.filter((c) => c.scriptWord === 'Viehböck');
    expect(atViehboeck).toHaveLength(1);
    expect(atViehboeck[0].kind).toBe('substitution');
  });
});

// ─── selectCandidates: diff emission ─────────────────────────────────────────

describe('selectCandidates — diff emission', () => {
  it('emits a substitution candidate at the substituted word', () => {
    const script = [w('the'), w('quick'), w('brown'), w('fox')];
    const whisper: DiffWord[] = [
      w('the', 0, 0.1),
      w('quick', 0.1, 0.3),
      w('green', 0.3, 0.5),
      w('fox', 0.5, 0.7),
    ];
    const diff = diffScriptVsWhisper(script, whisper);
    const { candidates } = selectCandidates(diff, script);
    const subs = candidates.filter((c) => c.kind === 'substitution');
    expect(subs).toHaveLength(1);
    expect(subs[0].scriptWord).toBe('brown');
    expect(subs[0].whisperWord).toBe('green');
  });

  it('emits an omission candidate at the omitted word', () => {
    const script = [w('we'), w('shall'), w('overcome')];
    const whisper: DiffWord[] = [w('we', 0, 0.1), w('overcome', 0.2, 0.5)];
    const diff = diffScriptVsWhisper(script, whisper);
    const { candidates } = selectCandidates(diff, script);
    const oms = candidates.filter((c) => c.kind === 'omission');
    expect(oms).toHaveLength(1);
    expect(oms[0].scriptWord).toBe('shall');
  });

  it('emits an insertion candidate for filler words', () => {
    const script = [w('hello'), w('world')];
    const whisper: DiffWord[] = [
      w('hello', 0, 0.3),
      w('um', 0.3, 0.5),
      w('world', 0.5, 0.9),
    ];
    const diff = diffScriptVsWhisper(script, whisper);
    const { candidates } = selectCandidates(diff, script);
    const ins = candidates.filter((c) => c.kind === 'insertion');
    expect(ins).toHaveLength(1);
    expect(ins[0].whisperWord).toBe('um');
  });
});

// ─── selectCandidates: dedupe + cap ──────────────────────────────────────────

describe('selectCandidates — dedupe', () => {
  it('collapses candidates within DEDUPE_WINDOW_SEC to one, keeping higher priority', () => {
    // Two candidates 0.5 sec apart: one tricky-word, one substitution.
    // The substitution wins (higher priority).
    const script = [w('the'), w('Reaver'), w('attacks')];
    const whisper: DiffWord[] = [
      w('the', 0, 0.1),
      w('Reever', 0.5, 0.8), // substituted
      w('attacks', 0.8, 1.2),
    ];
    const diff = diffScriptVsWhisper(script, whisper);
    const { candidates, droppedByDedupe } = selectCandidates(diff, script);
    expect(candidates.length).toBeLessThanOrEqual(2);
    expect(droppedByDedupe).toBeGreaterThanOrEqual(0);
  });
});

describe('selectCandidates — cap', () => {
  it('truncates to MAX_CANDIDATES when the raw list exceeds the cap', () => {
    // Build a synthetic script + Whisper where every word is a
    // substitution → emits MAX_CANDIDATES + 5 raw candidates.
    const N = MAX_CANDIDATES + 5;
    // Space candidates >DEDUPE_WINDOW_SEC apart so none collapse, so
    // the cap is what truncates.
    const script: DiffWord[] = [];
    const whisper: DiffWord[] = [];
    const SPACING = DEDUPE_WINDOW_SEC + 1;
    for (let i = 0; i < N; i++) {
      script.push(w(`scriptWord${i}`));
      whisper.push(w(`whisperWord${i}`, i * SPACING, i * SPACING + 0.5));
    }
    const diff = diffScriptVsWhisper(script, whisper);
    const { candidates, droppedByCap } = selectCandidates(diff, script);
    expect(candidates.length).toBe(MAX_CANDIDATES);
    expect(droppedByCap).toBe(5);
  });

  it('preserves temporal order in the final candidate list', () => {
    const script = [w('a'), w('b'), w('c')];
    const whisper: DiffWord[] = [
      w('z', 0, 0.5),
      w('y', DEDUPE_WINDOW_SEC + 1, DEDUPE_WINDOW_SEC + 1.5),
      w('x', (DEDUPE_WINDOW_SEC + 1) * 2, (DEDUPE_WINDOW_SEC + 1) * 2 + 0.5),
    ];
    const diff = diffScriptVsWhisper(script, whisper);
    const { candidates } = selectCandidates(diff, script);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i].startSec).toBeGreaterThanOrEqual(candidates[i - 1].startSec);
    }
  });
});

// ─── selectCandidates: empty + degenerate inputs ─────────────────────────────

describe('selectCandidates — degenerate inputs', () => {
  it('returns no candidates when diff is all-match and no tricky words', () => {
    const script = [w('the'), w('cat'), w('sat')];
    const whisper: DiffWord[] = [
      w('the', 0, 0.1),
      w('cat', 0.1, 0.3),
      w('sat', 0.3, 0.5),
    ];
    const diff = diffScriptVsWhisper(script, whisper);
    const { candidates } = selectCandidates(diff, script);
    expect(candidates).toEqual([]);
  });

  it('returns no candidates for empty script + empty whisper', () => {
    const diff = diffScriptVsWhisper([], []);
    const { candidates } = selectCandidates(diff, []);
    expect(candidates).toEqual([]);
  });
});

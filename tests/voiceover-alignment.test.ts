/**
 * Pure-helper tests for voiceover-aligned scene timing.
 *
 * The cursor walk in `alignRowsToWords` is load-bearing for every
 * production-doc render that's been linked to a voiceover, so the
 * surface here is intentionally tested against the eight edge cases
 * called out in `_plans/2026-05-13-voiceover-aligned-scene-timing.md`:
 *
 *   1. Happy path — aligner words match the script verbatim.
 *   2. Aligner over-segments a contraction (script "don't" splits
 *      into "don" + "t") — forward resync absorbs it.
 *   3. Aligner under-segments (two script words collapse into one
 *      aligner token) — backward resync absorbs it.
 *   4. Two adjacent rows with identical short text — cursor position
 *      keeps the second occurrence aligned after the first.
 *   5. Empty title-card row between spoken rows — estimated fallback,
 *      cursor preserved.
 *   6. Full mismatch — aligner content is unrelated; row falls back
 *      to estimated and subsequent rows still align.
 *   7. Character-edge punctuation ("don't", "e.g.") — normalisation
 *      strips punctuation, words still compare equal.
 *   8. Unicode dashes / curly quotes in script — normalised to ASCII
 *      before comparison.
 *
 * `levenshteinDistance` + `scriptDriftRatio` cover the staleness math
 * the production-doc page uses to surface the four-state pill.
 */
import { describe, expect, it } from 'vitest';
import {
  alignRowsToWords,
  buildCanonicalScript,
  levenshteinDistance,
  normaliseWord,
  scriptDriftRatio,
  snapMsToFrame,
} from '@/lib/voiceover-alignment';
import type { ForcedAlignmentResponse, ForcedAlignmentWord } from '@/lib/elevenlabs';

// Concise helper to spell out fake aligner words. Times in seconds, the
// shape ElevenLabs returns.
function w(text: string, start: number, end: number): ForcedAlignmentWord {
  return { text, start, end };
}

function align(words: ForcedAlignmentWord[]): ForcedAlignmentResponse {
  return { words };
}

// ─── normaliseWord ────────────────────────────────────────────────────────────

describe('normaliseWord', () => {
  it('lowercases and strips punctuation', () => {
    expect(normaliseWord('Hello,')).toBe('hello');
    expect(normaliseWord('e.g.')).toBe('eg');
    expect(normaliseWord('Don’t')).toBe("don't");
  });

  it('preserves digits, apostrophes, hyphens', () => {
    expect(normaliseWord("we're")).toBe("we're");
    expect(normaliseWord('state-of-the-art')).toBe('state-of-the-art');
    expect(normaliseWord('1995')).toBe('1995');
  });

  it('returns empty string for pure punctuation', () => {
    expect(normaliseWord('—')).toBe('');
    expect(normaliseWord('!?')).toBe('');
  });
});

// ─── snapMsToFrame ────────────────────────────────────────────────────────────

describe('snapMsToFrame', () => {
  it('rounds to the nearest frame at 30 fps (33.333… ms/frame)', () => {
    expect(snapMsToFrame(0, 30)).toBe(0);
    expect(snapMsToFrame(33, 30)).toBeCloseTo(33.333, 1);
    // 40 ms → frame 1.2 → round to frame 1 → 33.333 ms
    expect(snapMsToFrame(40, 30)).toBeCloseTo(33.333, 1);
    // 60 ms → frame 1.8 → round to frame 2 → 66.667 ms
    expect(snapMsToFrame(60, 30)).toBeCloseTo(66.667, 1);
  });

  it('passes through when fps is invalid', () => {
    expect(snapMsToFrame(123, 0)).toBe(123);
  });
});

// ─── alignRowsToWords — happy path ────────────────────────────────────────────

describe('alignRowsToWords: happy path', () => {
  it('aligns three rows whose words match the aligner verbatim', () => {
    const result = alignRowsToWords({
      rowScripts: ['Hello world.', 'How are you?', 'Goodbye now.'],
      fallbackStartMs: [0, 5000, 10_000],
      fallbackTotalMs: 15_000,
      alignment: align([
        w('Hello', 0.0, 0.5),
        w('world', 0.5, 1.0),
        w('How', 5.0, 5.3),
        w('are', 5.3, 5.6),
        w('you', 5.6, 6.0),
        w('Goodbye', 10.0, 10.5),
        w('now', 10.5, 11.0),
      ]),
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ rowIndex: 0, startMs: 0, source: 'aligned' });
    expect(result[1]).toMatchObject({ rowIndex: 1, startMs: 5000, endMs: 6000, source: 'aligned' });
    // Last row's endMs stretches to fallbackTotalMs to cover tail silence.
    expect(result[2]).toMatchObject({ rowIndex: 2, startMs: 10_000, endMs: 15_000, source: 'aligned' });
  });
});

// ─── alignRowsToWords — aligner over-segments (forward resync) ────────────────

describe('alignRowsToWords: forward resync absorbs over-segmentation', () => {
  it('matches "don\'t" against "don" + "t"', () => {
    const result = alignRowsToWords({
      rowScripts: ["Don't quit."],
      fallbackStartMs: [0],
      fallbackTotalMs: 5000,
      alignment: align([
        w('Don', 0.0, 0.3),
        w("t", 0.3, 0.4),
        w('quit', 0.4, 0.8),
      ]),
    });
    // First script word "Don't" matches the aligner's "Don" token —
    // normalisation strips the apostrophe so both compare as "dont".
    // Cursor advances past the stray "t" because the next script word
    // "quit" forward-resyncs to position 2.
    expect(result[0].source).toBe('aligned');
    expect(result[0].startMs).toBe(0);
    expect(result[0].endMs).toBe(5000); // last row, stretched to total
  });
});

// ─── alignRowsToWords — hyphenated compound split across tokens ──────────────

describe('alignRowsToWords: prefix-merge handles hyphenated compounds', () => {
  it('matches "state-of-the-art" against four separate aligner tokens', () => {
    const result = alignRowsToWords({
      rowScripts: ['Truly state-of-the-art.'],
      fallbackStartMs: [0],
      fallbackTotalMs: 5000,
      alignment: align([
        w('Truly', 0.0, 0.4),
        w('state', 0.4, 0.7),
        w('of', 0.7, 0.9),
        w('the', 0.9, 1.1),
        w('art', 1.1, 1.5),
      ]),
    });
    expect(result[0].source).toBe('aligned');
    expect(result[0].startMs).toBe(0);
  });
});

// ─── alignRowsToWords — aligner under-segments (backward resync) ──────────────

describe('alignRowsToWords: backward resync absorbs under-segmentation', () => {
  it('matches "good night" against a single "goodnight" token', () => {
    const result = alignRowsToWords({
      rowScripts: ['Say goodnight everyone.', 'Bye.'],
      fallbackStartMs: [0, 4000],
      fallbackTotalMs: 6000,
      // Aligner merged "good" + "night" into one "goodnight" token —
      // the script's two-word phrasing must collapse onto the single
      // aligner token without desyncing "everyone".
      alignment: align([
        w('Say', 0.0, 0.2),
        w('goodnight', 0.2, 0.7),
        w('everyone', 0.7, 1.2),
        w('Bye', 4.0, 4.4),
      ]),
    });
    expect(result[0]).toMatchObject({ source: 'aligned', startMs: 0 });
    expect(result[1]).toMatchObject({ source: 'aligned', startMs: 4000 });
  });
});

// ─── alignRowsToWords — duplicate adjacent rows ───────────────────────────────

describe('alignRowsToWords: duplicate adjacent rows', () => {
  it('aligns the second occurrence after the first via cursor position, not text identity', () => {
    const result = alignRowsToWords({
      rowScripts: ['NotPetya.', 'NotPetya.'],
      fallbackStartMs: [0, 2000],
      fallbackTotalMs: 4000,
      alignment: align([
        w('NotPetya', 0.0, 1.0),
        w('NotPetya', 2.0, 3.0),
      ]),
    });
    expect(result[0]).toMatchObject({ rowIndex: 0, startMs: 0, source: 'aligned' });
    expect(result[1].rowIndex).toBe(1);
    expect(result[1].source).toBe('aligned');
    // Second occurrence picked up the second aligner word (start 2.0s),
    // not re-matching against the first. End stretched to total.
    expect(result[1].startMs).toBe(2000);
    expect(result[1].endMs).toBe(4000);
  });
});

// ─── alignRowsToWords — empty title-card row ──────────────────────────────────

describe('alignRowsToWords: empty row between spoken rows', () => {
  it('preserves cursor across an empty row and keeps subsequent rows aligned', () => {
    const result = alignRowsToWords({
      rowScripts: ['First line.', '', 'Second line.'],
      fallbackStartMs: [0, 2000, 3000],
      fallbackTotalMs: 5000,
      alignment: align([
        w('First', 0.0, 0.5),
        w('line', 0.5, 1.0),
        w('Second', 3.0, 3.4),
        w('line', 3.4, 4.0),
      ]),
    });
    expect(result[0]).toMatchObject({ source: 'aligned', startMs: 0 });
    // Empty row keeps its estimated span.
    expect(result[1]).toMatchObject({ source: 'estimated', startMs: 2000, endMs: 3000 });
    // Third row's cursor wasn't consumed by the empty row → still matches.
    expect(result[2]).toMatchObject({ source: 'aligned', startMs: 3000 });
  });
});

// ─── alignRowsToWords — full mismatch ─────────────────────────────────────────

describe('alignRowsToWords: full mismatch on a row', () => {
  it('falls back to estimated for the bad row and keeps subsequent rows aligned', () => {
    const result = alignRowsToWords({
      rowScripts: ['Hello world.', 'Completely unrelated text here.', 'Goodbye now.'],
      fallbackStartMs: [0, 5000, 10_000],
      fallbackTotalMs: 15_000,
      // Middle row's aligner words are gibberish — no resync possible.
      alignment: align([
        w('Hello', 0.0, 0.5),
        w('world', 0.5, 1.0),
        w('zzz', 5.0, 5.2),
        w('xxx', 5.2, 5.4),
        w('yyy', 5.4, 5.6),
        w('aaa', 5.6, 5.8),
        w('Goodbye', 10.0, 10.5),
        w('now', 10.5, 11.0),
      ]),
      fuzzyWindow: 1,
    });
    expect(result[0]).toMatchObject({ source: 'aligned' });
    // Middle row uses its estimated timecode.
    expect(result[1]).toMatchObject({ source: 'estimated', startMs: 5000, endMs: 10_000 });
    // Third row still picks up its aligner words because the cursor
    // advanced by the failed row's word count (4) to position 6.
    expect(result[2]).toMatchObject({ source: 'aligned', startMs: 10_000 });
  });
});

// ─── alignRowsToWords — character-edge punctuation ────────────────────────────

describe('alignRowsToWords: punctuation-edge tokens normalise to equal', () => {
  it('matches "e.g." in the script against "eg" / "e.g" in the aligner', () => {
    const result = alignRowsToWords({
      rowScripts: ['"E.g.", consider this.'],
      fallbackStartMs: [0],
      fallbackTotalMs: 4000,
      alignment: align([
        w('eg', 0.0, 0.4),
        w('consider', 0.4, 1.0),
        w('this', 1.0, 1.4),
      ]),
    });
    expect(result[0].source).toBe('aligned');
    expect(result[0].startMs).toBe(0);
  });
});

// ─── alignRowsToWords — Unicode dashes / curly quotes ─────────────────────────

describe('alignRowsToWords: Unicode glyphs normalise to ASCII', () => {
  it('matches a script with curly quotes against ASCII-quoted aligner output', () => {
    const result = alignRowsToWords({
      rowScripts: ['She said “hello” — politely.'],
      fallbackStartMs: [0],
      fallbackTotalMs: 4000,
      alignment: align([
        w('She', 0.0, 0.2),
        w('said', 0.2, 0.5),
        w('hello', 0.5, 1.0),
        w('politely', 1.0, 1.8),
      ]),
    });
    expect(result[0].source).toBe('aligned');
    expect(result[0].startMs).toBe(0);
  });
});

// ─── alignRowsToWords — defensive shape checks ────────────────────────────────

describe('alignRowsToWords: defensive checks', () => {
  it('returns [] for an empty row list', () => {
    expect(
      alignRowsToWords({
        rowScripts: [],
        fallbackStartMs: [],
        fallbackTotalMs: 0,
        alignment: align([]),
      }),
    ).toEqual([]);
  });

  it('throws when rowScripts and fallbackStartMs lengths disagree', () => {
    expect(() =>
      alignRowsToWords({
        rowScripts: ['one', 'two'],
        fallbackStartMs: [0],
        fallbackTotalMs: 1000,
        alignment: align([]),
      }),
    ).toThrow(/same length/);
  });

  it('falls back gracefully when the aligner returned zero spoken words', () => {
    const result = alignRowsToWords({
      rowScripts: ['Hello world.'],
      fallbackStartMs: [0],
      fallbackTotalMs: 2000,
      alignment: align([]),
    });
    expect(result[0].source).toBe('estimated');
    expect(result[0].startMs).toBe(0);
    expect(result[0].endMs).toBe(2000);
  });
});

// ─── buildCanonicalScript ─────────────────────────────────────────────────────

describe('buildCanonicalScript', () => {
  it('joins non-empty rows with newlines and drops empty title cards', () => {
    expect(buildCanonicalScript(['Hello world.', '', 'Goodbye now.'])).toBe(
      'Hello world.\nGoodbye now.',
    );
  });

  it('normalises Unicode glyphs into ASCII before hashing', () => {
    expect(buildCanonicalScript(['She said “hi” — gone.'])).toBe('She said "hi" - gone.');
  });
});

// ─── Levenshtein-driven staleness ─────────────────────────────────────────────

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('returns the string length when one side is empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('counts substitutions, insertions, deletions', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('flaw', 'lawn')).toBe(2);
  });
});

// ─── realignVideoConfig (render-route integration) ────────────────────────────

describe('realignVideoConfig', () => {
  it('replaces estimated shot timings with frame-snapped aligned timings', async () => {
    const { realignVideoConfig } = await import('@/remotion/utils');
    const config = {
      fps: 30,
      width: 1920,
      height: 1080,
      shots: [
        // Estimated: shot 0 starts at 0, shot 1 at 4000 ms. But the
        // narrator started shot 1 at ~3200 ms — aligner reflects that.
        { startMs: 0, durationMs: 4000, sceneType: 'b-roll' as const, scriptText: 'Hello world.' },
        { startMs: 4000, durationMs: 4000, sceneType: 'b-roll' as const, scriptText: 'Goodbye now.' },
      ],
      brand: {
        primaryColor: '#000', secondaryColor: '#000', backgroundColor: '#fff',
        textColor: '#000', titleColor: '#000', fontFamily: 'Inter', titleFontFamily: 'Inter',
      },
    };
    const alignment = align([
      w('Hello', 0.0, 0.5),
      w('world', 0.5, 1.0),
      w('Goodbye', 3.2, 3.7),
      w('now', 3.7, 4.2),
    ]);
    const result = realignVideoConfig(config, alignment);
    expect(result.alignedRows).toHaveLength(2);
    expect(result.alignedRows[0].source).toBe('aligned');
    expect(result.alignedRows[1].source).toBe('aligned');
    // Frame-snapped at 30 fps (33.33 ms / frame).
    expect(result.config.shots[1].startMs).toBeCloseTo(3200, -1);
    // Last shot's endMs stretches to fallbackTotalMs (last shot's
    // estimated end = 4000 + 4000 = 8000), so duration ≈ 8000 - 3200.
    expect(result.config.shots[1].durationMs).toBeGreaterThan(4700);
  });
});

describe('scriptDriftRatio', () => {
  it('returns 0 when both scripts are empty', () => {
    expect(scriptDriftRatio('', '')).toBe(0);
  });

  it('returns 1 when one side is empty', () => {
    expect(scriptDriftRatio('', 'anything')).toBe(1);
    expect(scriptDriftRatio('anything', '')).toBe(1);
  });

  it('is below the 5% soft-realign threshold for a typo fix', () => {
    const old = 'A quick brown fox jumps over the lazy dog. The end.';
    const fresh = 'A quick brown fox jumped over the lazy dog. The end.';
    expect(scriptDriftRatio(old, fresh)).toBeLessThan(0.05);
  });

  it('is above the 20% re-record threshold for a wholesale rewrite', () => {
    const old = 'Hello world.';
    const fresh = 'A completely different sentence about something else entirely.';
    expect(scriptDriftRatio(old, fresh)).toBeGreaterThan(0.2);
  });
});

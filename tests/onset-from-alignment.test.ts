import { describe, expect, it } from 'vitest';
import { onsetFromAlignment } from '@/lib/onset-from-alignment';
import type { VisemeWord } from '@/lib/viseme-from-alignment';

// ─── onsetFromAlignment ──────────────────────────────────────────────
//
// Pure function — rebases a label_pop beat's startMs onto the actual
// word's onset from the project's forced-alignment word slice. Falls
// back to the LLM's estimate when no match is possible. A regression
// on the matcher silently drifts every label out of audio sync.

function words(...specs: Array<{ text: string; startMs: number; endMs: number }>): VisemeWord[] {
  return specs;
}

// ─── Single-word matching ────────────────────────────────────────────

describe('onsetFromAlignment — single word', () => {
  it('returns the per-shot ms of an exact case-insensitive match', () => {
    const ms = onsetFromAlignment({
      words: words(
        { text: 'the', startMs: 1000, endMs: 1100 },
        { text: 'Vaqueros', startMs: 1300, endMs: 1700 }, // capitalised in alignment
        { text: 'roamed', startMs: 1750, endMs: 2050 },
      ),
      labelText: 'vaqueros', // lowercase in beat payload
      shotStartMs: 1000,
      fallbackStartMs: 9999,
    });
    // Absolute onset 1300 ms, shot starts at 1000 → 300 ms per-shot.
    expect(ms).toBe(300);
  });

  it('strips outer punctuation from the alignment word', () => {
    const ms = onsetFromAlignment({
      words: words(
        { text: 'Vaqueros,', startMs: 500, endMs: 900 }, // trailing comma
      ),
      labelText: 'Vaqueros',
      shotStartMs: 500,
      fallbackStartMs: 9999,
    });
    expect(ms).toBe(0);
  });

  it('matches via substring (label is part of a larger word)', () => {
    // Edge case: LLM emits "FOX" but the alignment has "Foxes". The
    // pop-on should still land on the right syllable.
    const ms = onsetFromAlignment({
      words: words(
        { text: 'the', startMs: 0, endMs: 100 },
        { text: 'Foxes', startMs: 200, endMs: 600 },
      ),
      labelText: 'FOX',
      shotStartMs: 0,
      fallbackStartMs: 9999,
    });
    expect(ms).toBe(200);
  });

  it("falls back when the label can't be matched", () => {
    const ms = onsetFromAlignment({
      words: words(
        { text: 'the', startMs: 0, endMs: 100 },
        { text: 'rope', startMs: 200, endMs: 400 },
      ),
      labelText: 'BANANAS',
      shotStartMs: 0,
      fallbackStartMs: 1500,
    });
    expect(ms).toBe(1500);
  });

  it('returns the FIRST match when the label appears multiple times', () => {
    const ms = onsetFromAlignment({
      words: words(
        { text: 'cargo', startMs: 100, endMs: 400 },
        { text: 'cargo', startMs: 5500, endMs: 5800 }, // second mention
      ),
      labelText: 'Cargo',
      shotStartMs: 0,
      fallbackStartMs: 9999,
    });
    expect(ms).toBe(100);
  });

  it('clamps to 0 if the matched word starts before the shot', () => {
    // Alignment drift: the matched word's absolute startMs is BEFORE
    // shotStartMs (cross-shot word boundary). Negative per-shot ms
    // would break Sequence's `from` prop, so we clamp.
    const ms = onsetFromAlignment({
      words: words({ text: 'cargo', startMs: 800, endMs: 1100 }),
      labelText: 'cargo',
      shotStartMs: 1000, // shot starts AFTER the word
      fallbackStartMs: 9999,
    });
    expect(ms).toBe(0);
  });
});

// ─── Multi-word phrase matching ──────────────────────────────────────

describe('onsetFromAlignment — multi-word phrase', () => {
  it('matches an exact two-word phrase to the first word', () => {
    const ms = onsetFromAlignment({
      words: words(
        { text: 'the', startMs: 0, endMs: 100 },
        { text: 'Mary', startMs: 200, endMs: 400 },
        { text: 'Celeste', startMs: 450, endMs: 800 },
        { text: 'drifted', startMs: 900, endMs: 1200 },
      ),
      labelText: 'Mary Celeste',
      shotStartMs: 0,
      fallbackStartMs: 9999,
    });
    expect(ms).toBe(200);
  });

  it('matches when the phrase is part of a longer phrase', () => {
    const ms = onsetFromAlignment({
      words: words(
        { text: 'Captain', startMs: 100, endMs: 400 },
        { text: 'Benjamin', startMs: 450, endMs: 750 },
        { text: 'Briggs', startMs: 800, endMs: 1100 },
      ),
      labelText: 'Benjamin Briggs',
      shotStartMs: 0,
      fallbackStartMs: 9999,
    });
    expect(ms).toBe(450);
  });

  it('falls through to first-token match when the full phrase is not contiguous', () => {
    // Multi-word phrase isn't a contiguous span — pick the first word
    // that matches the first token. Better than blind fallback.
    const ms = onsetFromAlignment({
      words: words(
        { text: 'lost', startMs: 100, endMs: 300 },
        { text: 'media', startMs: 350, endMs: 600 },
        { text: 'never', startMs: 650, endMs: 900 },
        { text: 'recovered', startMs: 950, endMs: 1400 },
      ),
      labelText: 'never recovered media',
      shotStartMs: 0,
      fallbackStartMs: 9999,
    });
    // Full phrase doesn't match; first-token 'never' matches at 650.
    expect(ms).toBe(650);
  });

  it('falls back when neither phrase nor first token matches', () => {
    const ms = onsetFromAlignment({
      words: words({ text: 'hello', startMs: 0, endMs: 200 }),
      labelText: 'goodnight moon',
      shotStartMs: 0,
      fallbackStartMs: 7777,
    });
    expect(ms).toBe(7777);
  });
});

// ─── Defense in depth ────────────────────────────────────────────────

describe('onsetFromAlignment — defense in depth', () => {
  it('falls back when words is undefined', () => {
    expect(
      onsetFromAlignment({
        words: undefined,
        labelText: 'anything',
        shotStartMs: 0,
        fallbackStartMs: 500,
      }),
    ).toBe(500);
  });

  it('falls back when words is empty', () => {
    expect(
      onsetFromAlignment({
        words: [],
        labelText: 'anything',
        shotStartMs: 0,
        fallbackStartMs: 500,
      }),
    ).toBe(500);
  });

  it('falls back when labelText is empty', () => {
    expect(
      onsetFromAlignment({
        words: words({ text: 'word', startMs: 0, endMs: 100 }),
        labelText: '',
        shotStartMs: 0,
        fallbackStartMs: 333,
      }),
    ).toBe(333);
  });

  it('falls back when labelText is whitespace only', () => {
    expect(
      onsetFromAlignment({
        words: words({ text: 'word', startMs: 0, endMs: 100 }),
        labelText: '   \t  ',
        shotStartMs: 0,
        fallbackStartMs: 333,
      }),
    ).toBe(333);
  });

  it("ignores trailing punctuation on the label text too", () => {
    // The label "VAQUEROS!" should still match the alignment word
    // "Vaqueros" — outer punctuation is symmetric.
    const ms = onsetFromAlignment({
      words: words({ text: 'Vaqueros', startMs: 200, endMs: 600 }),
      labelText: 'VAQUEROS!',
      shotStartMs: 0,
      fallbackStartMs: 9999,
    });
    expect(ms).toBe(200);
  });
});

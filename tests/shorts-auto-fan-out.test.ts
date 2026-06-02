import { describe, expect, it } from 'vitest';
import { synthesizeSegments } from '@/lib/shorts-auto-fan-out';
import { WORDS_PER_SECOND } from '@/lib/shorts-types';

/**
 * `runAutoFanOut` itself hits the DB; tested via integration.
 * `synthesizeSegments` is the pure-helper kernel — that's what
 * these tests cover.
 */

describe('synthesizeSegments — empty / garbage input', () => {
  it('returns [] for empty string', () => {
    expect(synthesizeSegments('')).toEqual([]);
  });

  it('returns [] for whitespace-only input', () => {
    expect(synthesizeSegments('   \n\t   ')).toEqual([]);
  });

  it('returns [] for non-string input', () => {
    // @ts-expect-error — runtime defence
    expect(synthesizeSegments(null)).toEqual([]);
    // @ts-expect-error — runtime defence
    expect(synthesizeSegments(undefined)).toEqual([]);
    // @ts-expect-error — runtime defence
    expect(synthesizeSegments(42)).toEqual([]);
  });

  it('returns [] for input that is only production markers', () => {
    expect(synthesizeSegments('[VISUAL: a car] [PAUSE]')).toEqual([]);
  });
});

describe('synthesizeSegments — sentence splitting', () => {
  it('produces one segment per sentence', () => {
    const segments = synthesizeSegments(
      'First sentence here. Second sentence! Third one?',
    );
    expect(segments.length).toBe(3);
    expect(segments[0]!.text).toBe('First sentence here.');
    expect(segments[1]!.text).toBe('Second sentence!');
    expect(segments[2]!.text).toBe('Third one?');
  });

  it('skips empty sentence fragments', () => {
    const segments = synthesizeSegments('A.    B!     C?');
    expect(segments.length).toBe(3);
  });

  it('strips [bracketed] production markers from word count', () => {
    const segments = synthesizeSegments(
      'A short sentence. [VISUAL: an explosion] Another short sentence.',
    );
    expect(segments.length).toBe(2);
    // The marker is stripped — no segment for it.
    expect(segments.some((s) => s.text.includes('VISUAL'))).toBe(false);
  });
});

describe('synthesizeSegments — duration estimation', () => {
  it('duration scales with word count via WORDS_PER_SECOND', () => {
    // 7 words at 2.33 wps ≈ 3000ms; floor is 1000ms so the floor never
    // bites here.
    const seven = 'one two three four five six seven.';
    const expected = Math.round((7 / WORDS_PER_SECOND) * 1000);
    const [seg] = synthesizeSegments(seven);
    expect(seg!.duration_ms).toBe(expected);
  });

  it('clamps very-short segments to a 1000ms floor', () => {
    const [seg] = synthesizeSegments('Go.');
    expect(seg!.duration_ms).toBeGreaterThanOrEqual(1000);
  });

  it('offsets are monotonically increasing and contiguous', () => {
    const segments = synthesizeSegments(
      'First sentence here with words. Second sentence here. Third sentence.',
    );
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.offset_ms).toBe(
        segments[i - 1]!.offset_ms + segments[i - 1]!.duration_ms,
      );
    }
  });
});

describe('synthesizeSegments — realistic script', () => {
  it('produces enough segments for clip-scorer to find candidates', () => {
    const realistic = [
      'Most creators ignore the first frame of every Short.',
      "Here's why that costs them views.",
      'The algorithm decides in the first half-second whether to keep showing it.',
      'If your hook is weak, the swipe rate spikes and the boost dies.',
      'There are three ways to win that half-second.',
      'One: open with a number.',
      'Two: ask a question.',
      'Three: state a counter-intuitive claim and back it up by the third frame.',
      'Try one of these on your next Short.',
      'See how the retention changes.',
    ].join(' ');

    const segments = synthesizeSegments(realistic);
    expect(segments.length).toBe(10);
    // Total estimated duration should land in the long-form range
    // (well over 45 seconds).
    const totalSec = segments.reduce((sum, s) => sum + s.duration_ms, 0) / 1000;
    expect(totalSec).toBeGreaterThan(30);
  });
});

import { describe, expect, it } from 'vitest';
import { scoreClips, type ClipScorerSegment } from '@/lib/clip-scorer';

/**
 * Synthetic transcripts let us test ranking behaviour deterministically.
 * Real transcripts are too noisy to assert exact scores against.
 */

/** Build a uniform-pacing transcript. Each segment is N words long with
 *  a fixed gap. Useful when only the TEXT content matters to the test. */
function buildTranscript(
  texts: string[],
  opts: { segmentMs?: number; gapMs?: number } = {},
): ClipScorerSegment[] {
  const segmentMs = opts.segmentMs ?? 2500;
  const gapMs = opts.gapMs ?? 0;
  let offset = 0;
  return texts.map((text) => {
    const seg: ClipScorerSegment = { text, offset_ms: offset, duration_ms: segmentMs };
    offset += segmentMs + gapMs;
    return seg;
  });
}

describe('scoreClips — edge cases', () => {
  it('returns [] for empty input', () => {
    expect(scoreClips([])).toEqual([]);
  });

  it('returns [] when all segments have non-finite offsets', () => {
    const trash: ClipScorerSegment[] = [
      { text: 'x', offset_ms: NaN, duration_ms: 1000 },
      { text: 'y', offset_ms: Infinity, duration_ms: 1000 },
    ];
    expect(scoreClips(trash)).toEqual([]);
  });

  it('respects custom targetSeconds and clamps to [15, 90]', () => {
    const t = buildTranscript(Array(40).fill('word word word word word word'));
    const tooShort = scoreClips(t, { targetSeconds: 5 }); // clamps to 15
    const tooLong = scoreClips(t, { targetSeconds: 999 }); // clamps to 90
    // Both still produce candidates given enough source material.
    expect(tooShort.length).toBeGreaterThan(0);
    expect(tooLong.length).toBeGreaterThan(0);
    expect(tooShort[0]!.durationSeconds).toBeGreaterThanOrEqual(15 * 0.6);
    expect(tooLong[0]!.durationSeconds).toBeLessThanOrEqual(90 * 1.5);
  });

  it('returns at most topN candidates', () => {
    const t = buildTranscript(Array(60).fill('word word word word word'));
    const r = scoreClips(t, { topN: 3 });
    expect(r.length).toBeLessThanOrEqual(3);
  });
});

describe('scoreClips — ranking', () => {
  it('ranks strong-hook windows above weak-hook windows', () => {
    // First moment opens with a question (strong hook).
    // Second moment opens with channel boilerplate (weak hook).
    // Both windows have identical density and length.
    const strongHook = [
      'Why are most shorts dead on arrival?',
      'Because the first second is wasted on a logo or a hey-guys.',
      'You have one second to win the swipe. Use it.',
      'Numbers do better than words: try a three.',
      'Stop scrolling now.',
    ];
    const weakHook = [
      'Hey guys welcome back to the channel today.',
      'In this video we are going to be talking about a few things.',
      'It is going to be a good one I think you will like.',
      'Anyway let us get started with the main point.',
      'Subscribe if you like it.',
    ];
    const segs = [
      ...buildTranscript(strongHook, { segmentMs: 9000 }),
      // Insert a quiet gap so the windows can't merge.
      { text: '...', offset_ms: 50_000, duration_ms: 500 },
      ...buildTranscript(weakHook, { segmentMs: 9000 }).map((s) => ({
        ...s,
        offset_ms: s.offset_ms + 60_000,
      })),
    ];
    const r = scoreClips(segs, { topN: 5 });
    expect(r.length).toBeGreaterThan(0);
    const winner = r[0]!;
    expect(winner.text.toLowerCase()).toMatch(/why are most shorts/);
  });

  it('penalises mid-thought openers via standaloneScore', () => {
    const standalone = scoreClips(
      buildTranscript([
        'Three reasons your video underperforms.',
        'Reason one is the hook missing payoff.',
        'Reason two is the pacing being uneven.',
        'Reason three is the script being too long.',
        'Fix any one and you will see a lift.',
      ], { segmentMs: 9000 }),
      { topN: 1 },
    );
    const midThought = scoreClips(
      buildTranscript([
        'And that brings me to the next point.',
        'As I said earlier the pacing matters.',
        'But you also need to fix the script.',
        'Because the hook alone is not enough.',
        'So you have to keep iterating constantly.',
      ], { segmentMs: 9000 }),
      { topN: 1 },
    );
    expect(standalone[0]!.standaloneScore).toBeGreaterThan(midThought[0]!.standaloneScore);
  });

  it('returns non-overlapping candidates by default', () => {
    // Long uniform transcript will produce many overlapping windows.
    const t = buildTranscript(
      Array(40).fill('word word word word word word word'),
      { segmentMs: 5000 },
    );
    const r = scoreClips(t, { topN: 3 });
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        const a = r[i]!;
        const b = r[j]!;
        const overlap = a.startMs < b.endMs && a.endMs > b.startMs;
        expect(overlap, `candidates ${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  it('returns overlapping candidates when nonOverlapping is false', () => {
    const t = buildTranscript(
      Array(40).fill('word word word word word word word'),
      { segmentMs: 5000 },
    );
    const r = scoreClips(t, { topN: 10, nonOverlapping: false });
    // With overlap permitted, we get more candidates than with it forbidden.
    const rNoOverlap = scoreClips(t, { topN: 10, nonOverlapping: true });
    expect(r.length).toBeGreaterThanOrEqual(rNoOverlap.length);
  });
});

describe('scoreClips — sub-scores reflect inputs', () => {
  it('hookScore is computed against the first ~1.5s', () => {
    const r = scoreClips(
      buildTranscript([
        'Why are creators ignoring this?',
        'Because they think hooks are obvious.',
        'They are not. Hooks are the whole game.',
      ], { segmentMs: 15_000 }),
      { topN: 1, targetSeconds: 30 },
    );
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.hookScore).toBeGreaterThan(0.55);
    expect(r[0]!.hookText.toLowerCase()).toMatch(/why are creators/);
  });

  it('densityScore peaks in the 2.0–2.7 wps sweet spot', () => {
    // 60 words over 30 seconds = 2.0 wps → should land near peak.
    const segments: ClipScorerSegment[] = [
      {
        text: Array(60).fill('w').join(' '),
        offset_ms: 0,
        duration_ms: 30_000,
      },
    ];
    const r = scoreClips(segments, { topN: 1, targetSeconds: 30 });
    expect(r[0]!.densityScore).toBeGreaterThan(0.9);
  });

  it('densityScore falls off at very low wps', () => {
    // 10 words over 30 seconds = 0.33 wps → far below floor.
    const segments: ClipScorerSegment[] = [
      {
        text: Array(10).fill('w').join(' '),
        offset_ms: 0,
        duration_ms: 30_000,
      },
    ];
    const r = scoreClips(segments, { topN: 1, targetSeconds: 30 });
    expect(r[0]!.densityScore).toBeLessThan(0.5);
  });

  it('payoffScore rewards explicit payoff markers in the last sentence', () => {
    const segments: ClipScorerSegment[] = buildTranscript([
      'Many creators stall around the 30-day mark.',
      'They run out of ideas, they lose pace, they get tired.',
      'Here is the trick: pre-batch your hooks for two weeks.',
    ], { segmentMs: 10_000 });
    const r = scoreClips(segments, { topN: 1, targetSeconds: 30 });
    expect(r[0]!.payoffScore).toBeGreaterThan(0.4);
  });
});

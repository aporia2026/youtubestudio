import { describe, expect, it } from 'vitest';
import { planMotionCollageWindows } from '@/remotion/motion-collage-frame-math';

// planMotionCollageWindows divides a shot's frame window across N
// panels using floor + last-panel-absorbs-remainder. The total must
// equal the input duration exactly — overshoot makes Remotion clip
// the last panel, undershoot leaves a blank tail.
//
// Edge cases pinned here:
//   - clean division (duration % N === 0)
//   - +1 remainder
//   - bigger remainder (~5)
//   - N=1 (whole window to one panel)
//   - N=0 / negative (returns empty)
//   - duration=0 (all-zero windows)
//   - duration < N (early panels at 0; last absorbs)
//   - non-integer inputs (rejected via empty / zero arrays)

describe('planMotionCollageWindows — clean division', () => {
  it('divides 120 frames evenly across 4 panels (30 each, 0 remainder)', () => {
    const windows = planMotionCollageWindows(120, 4);
    expect(windows).toHaveLength(4);
    expect(windows.map((w) => w.from)).toEqual([0, 30, 60, 90]);
    expect(windows.map((w) => w.durationInFrames)).toEqual([30, 30, 30, 30]);
    expect(sumDurations(windows)).toBe(120);
  });

  it('divides 90 frames across 9 panels (10 each)', () => {
    const windows = planMotionCollageWindows(90, 9);
    expect(windows).toHaveLength(9);
    expect(windows.every((w) => w.durationInFrames === 10)).toBe(true);
    expect(sumDurations(windows)).toBe(90);
  });
});

describe('planMotionCollageWindows — remainder absorbed by last panel', () => {
  it('absorbs +1 remainder into the last panel (121/4)', () => {
    const windows = planMotionCollageWindows(121, 4);
    expect(windows).toHaveLength(4);
    expect(windows.map((w) => w.durationInFrames)).toEqual([30, 30, 30, 31]);
    expect(windows.map((w) => w.from)).toEqual([0, 30, 60, 90]);
    expect(sumDurations(windows)).toBe(121);
  });

  it('absorbs +5 remainder into the last panel (125/4)', () => {
    const windows = planMotionCollageWindows(125, 4);
    expect(windows.map((w) => w.durationInFrames)).toEqual([31, 31, 31, 32]);
    // sum = 125, check
    expect(sumDurations(windows)).toBe(125);
  });

  it('handles a 6-panel split with remainder (100/6 → 16+16+16+16+16+20)', () => {
    const windows = planMotionCollageWindows(100, 6);
    expect(windows.map((w) => w.durationInFrames)).toEqual([16, 16, 16, 16, 16, 20]);
    expect(sumDurations(windows)).toBe(100);
  });
});

describe('planMotionCollageWindows — N = 1 edge case', () => {
  it('returns a single window covering the whole duration', () => {
    const windows = planMotionCollageWindows(180, 1);
    expect(windows).toEqual([{ from: 0, durationInFrames: 180 }]);
  });
});

describe('planMotionCollageWindows — invalid panel counts', () => {
  it.each([0, -1, -10, 1.5, NaN, Infinity])('returns [] for panelCount=%s', (panelCount) => {
    const windows = planMotionCollageWindows(120, panelCount);
    expect(windows).toEqual([]);
  });
});

describe('planMotionCollageWindows — zero / invalid duration', () => {
  it.each([0, -10, NaN, Infinity, 1.5])(
    'returns N zero-duration windows for durationInFrames=%s',
    (duration) => {
      const windows = planMotionCollageWindows(duration, 4);
      expect(windows).toHaveLength(4);
      expect(windows.every((w) => w.durationInFrames === 0)).toBe(true);
    },
  );
});

describe('planMotionCollageWindows — duration < N (degenerate but defensive)', () => {
  it('hands the whole window to the last panel when N > duration (3 frames / 4 panels)', () => {
    const windows = planMotionCollageWindows(3, 4);
    expect(windows).toHaveLength(4);
    // floor(3/4) = 0 → early three panels have 0 frames; last absorbs
    // 0 + (3 - 0*4) = 3.
    expect(windows.map((w) => w.durationInFrames)).toEqual([0, 0, 0, 3]);
    // The total still equals the input duration so Remotion's outer
    // shot composition stays correct.
    expect(sumDurations(windows)).toBe(3);
  });

  it('keeps `from` offsets stable even when early panels collapse to 0', () => {
    const windows = planMotionCollageWindows(3, 4);
    // Every `from` is `i * panelFrames` = `i * 0` = 0 in this case.
    // The renderer's defensive `if (durationInFrames <= 0) return null`
    // means these 0-frame entries are skipped, so overlapping from
    // values are harmless. Pinned here so future refactors don't
    // accidentally change the contract.
    expect(windows.map((w) => w.from)).toEqual([0, 0, 0, 0]);
  });
});

describe('planMotionCollageWindows — totals invariant', () => {
  it('total durations always equal the input window across many (duration, N) pairs', () => {
    const pairs: Array<[number, number]> = [
      [120, 4],
      [150, 6],
      [200, 9],
      [333, 7],
      [1000, 12],
      [60, 16],
      [125, 4],
      [300, 5],
    ];
    for (const [duration, N] of pairs) {
      const windows = planMotionCollageWindows(duration, N);
      expect(sumDurations(windows)).toBe(duration);
    }
  });
});

function sumDurations(windows: ReturnType<typeof planMotionCollageWindows>): number {
  return windows.reduce((acc, w) => acc + w.durationInFrames, 0);
}

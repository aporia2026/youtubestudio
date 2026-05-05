import { describe, expect, it } from 'vitest';
import {
  computeFirstWindowVelocity,
  hoursBetween,
  qualifiesAsBreakout,
} from '@/lib/breakout-detector';

describe('hoursBetween', () => {
  it('returns the difference in hours', () => {
    expect(
      hoursBetween('2026-01-01T00:00:00Z', '2026-01-01T05:00:00Z'),
    ).toBeCloseTo(5, 5);
  });

  it('returns negative when "to" is before "from"', () => {
    expect(
      hoursBetween('2026-01-01T05:00:00Z', '2026-01-01T00:00:00Z'),
    ).toBeCloseTo(-5, 5);
  });

  it('returns null when either timestamp is unparseable', () => {
    expect(hoursBetween('not-a-date', '2026-01-01T00:00:00Z')).toBeNull();
    expect(hoursBetween('2026-01-01T00:00:00Z', 'also-bad')).toBeNull();
  });
});

describe('computeFirstWindowVelocity', () => {
  it('limits the velocity window to the first N hours since publish', () => {
    // Published at T=0. Window = first 48h. Trajectory:
    //   T=1h: 100 views
    //   T=24h: 1000 views
    //   T=48h: 2000 views
    //   T=72h: 5000 views (OUTSIDE the window — must be excluded)
    const rows = [
      { views: 100, captured_at: '2026-01-01T01:00:00Z' },
      { views: 1000, captured_at: '2026-01-02T00:00:00Z' },
      { views: 2000, captured_at: '2026-01-03T00:00:00Z' },
      { views: 5000, captured_at: '2026-01-04T00:00:00Z' },
    ];
    const v = computeFirstWindowVelocity(rows, '2026-01-01T00:00:00Z', 48);
    // Within window: first row T=1h (100), last T=48h (2000). 47h gap.
    // velocity = (2000 - 100) / 47 ≈ 40.43/hr
    expect(v).toBeCloseTo((2000 - 100) / 47, 2);
  });

  it('returns null when fewer than 2 rows fall in the window', () => {
    const rows = [{ views: 100, captured_at: '2026-01-04T00:00:00Z' }]; // T=72h
    const v = computeFirstWindowVelocity(rows, '2026-01-01T00:00:00Z', 48);
    expect(v).toBeNull();
  });

  it('excludes rows captured BEFORE publish (defence in depth)', () => {
    const rows = [
      { views: 100, captured_at: '2025-12-31T00:00:00Z' }, // before publish
      { views: 200, captured_at: '2026-01-01T01:00:00Z' },
      { views: 500, captured_at: '2026-01-01T05:00:00Z' },
    ];
    const v = computeFirstWindowVelocity(rows, '2026-01-01T00:00:00Z', 48);
    // Only the two within-window rows should count: 200 → 500 over 4h
    expect(v).toBeCloseTo((500 - 200) / 4, 2);
  });
});

describe('qualifiesAsBreakout', () => {
  it('refuses when the population is too sparse', () => {
    // 4 entries < default minPopulation of 5
    const d = qualifiesAsBreakout(1000, [10, 20, 30, 40]);
    expect(d.qualifies).toBe(false);
  });

  it('fires when value beats every other entry (clearly above p90)', () => {
    const population = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const d = qualifiesAsBreakout(1000, population);
    expect(d.qualifies).toBe(true);
    expect(d.percentile).toBeCloseTo(1, 5);
  });

  it('does NOT fire when value is exactly at p90 (tie excluded)', () => {
    // 10 entries: 1..10. p90 = ceil(0.9 * 10) = 9th index → value 9.
    // A candidate of 9 has percentile = 9/10 = 0.9 (>=0.9 threshold)
    // BUT velocity > p90 must be strict-greater. 9 > 9 is false → no fire.
    const d = qualifiesAsBreakout(9, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(d.qualifies).toBe(false);
    expect(d.percentile).toBeCloseTo(0.9, 5);
    expect(d.channel_p90).toBe(9);
  });

  it('respects a custom percentile threshold', () => {
    const population = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // Threshold 0.5 = pickier on the percentile but easier on the
    // raw value. Candidate 6 has percentile 0.6 ≥ 0.5 AND beats
    // the p50 entry (5).
    const d = qualifiesAsBreakout(6, population, { percentileThreshold: 0.5 });
    expect(d.qualifies).toBe(true);
  });

  it('respects custom minPopulation', () => {
    const d = qualifiesAsBreakout(100, [1, 2, 3], { minPopulation: 3 });
    // Population now meets the threshold; candidate 100 beats every entry.
    expect(d.qualifies).toBe(true);
  });

  it('does NOT fire when value is below threshold even on a tiny channel', () => {
    const d = qualifiesAsBreakout(1, [10, 20, 30, 40, 50]);
    expect(d.qualifies).toBe(false);
  });
});

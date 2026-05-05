import { describe, expect, it } from 'vitest';
import {
  bucketByDay,
  computeViewVelocityPerHour,
  percentileOfVelocity,
} from '@/lib/analytics-history';

describe('computeViewVelocityPerHour', () => {
  it('returns null for fewer than 2 rows', () => {
    expect(computeViewVelocityPerHour([])).toBeNull();
    expect(
      computeViewVelocityPerHour([{ views: 100, captured_at: '2026-01-01T00:00:00Z' }]),
    ).toBeNull();
  });

  it('returns null when the window is shorter than 1 hour', () => {
    // Two rows 30 minutes apart — not enough signal.
    const v = computeViewVelocityPerHour([
      { views: 100, captured_at: '2026-01-01T00:00:00Z' },
      { views: 200, captured_at: '2026-01-01T00:30:00Z' },
    ]);
    expect(v).toBeNull();
  });

  it('returns null when either bookend has no view count', () => {
    expect(
      computeViewVelocityPerHour([
        { views: null, captured_at: '2026-01-01T00:00:00Z' },
        { views: 200, captured_at: '2026-01-01T05:00:00Z' },
      ]),
    ).toBeNull();
    expect(
      computeViewVelocityPerHour([
        { views: 100, captured_at: '2026-01-01T00:00:00Z' },
        { views: null, captured_at: '2026-01-01T05:00:00Z' },
      ]),
    ).toBeNull();
  });

  it('computes views-per-hour from the first and last rows', () => {
    const v = computeViewVelocityPerHour([
      { views: 1000, captured_at: '2026-01-01T00:00:00Z' },
      { views: 2000, captured_at: '2026-01-01T05:00:00Z' },
    ]);
    expect(v).toBeCloseTo(200, 5);
  });

  it('sorts defensively when input is newest-first (matches DB order)', () => {
    const v = computeViewVelocityPerHour([
      { views: 2000, captured_at: '2026-01-01T05:00:00Z' },
      { views: 1500, captured_at: '2026-01-01T03:00:00Z' },
      { views: 1000, captured_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(v).toBeCloseTo(200, 5);
  });

  it('handles a fractional hour window correctly', () => {
    // 90-minute window, 300 views gained → 200 per hour.
    const v = computeViewVelocityPerHour([
      { views: 1000, captured_at: '2026-01-01T00:00:00Z' },
      { views: 1300, captured_at: '2026-01-01T01:30:00Z' },
    ]);
    expect(v).toBeCloseTo(200, 5);
  });
});

describe('bucketByDay', () => {
  it('returns empty for empty input', () => {
    expect(bucketByDay([])).toEqual([]);
  });

  it('keeps the latest snapshot per UTC day', () => {
    // Three snapshots on Jan 1, two on Jan 2. End-of-day for each
    // should win (the LATEST captured_at within the day).
    const out = bucketByDay([
      { views: 100, ctr_percentage: 4.0, average_view_percentage: 35, captured_at: '2026-01-01T01:00:00Z' },
      { views: 250, ctr_percentage: 4.5, average_view_percentage: 38, captured_at: '2026-01-01T18:00:00Z' },
      { views: 200, ctr_percentage: 4.2, average_view_percentage: 37, captured_at: '2026-01-01T12:00:00Z' },
      { views: 400, ctr_percentage: 4.1, average_view_percentage: 36, captured_at: '2026-01-02T06:00:00Z' },
      { views: 500, ctr_percentage: 3.9, average_view_percentage: 35, captured_at: '2026-01-02T22:00:00Z' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.date).toBe('2026-01-01');
    expect(out[0]!.views).toBe(250);
    expect(out[0]!.views_gained).toBeNull(); // first day, nothing to diff
    expect(out[1]!.date).toBe('2026-01-02');
    expect(out[1]!.views).toBe(500);
    expect(out[1]!.views_gained).toBe(250); // 500 - 250
  });

  it('clamps negative views_gained to 0 (YouTube re-counts can shrink the running total)', () => {
    const out = bucketByDay([
      { views: 1000, ctr_percentage: null, average_view_percentage: null, captured_at: '2026-01-01T20:00:00Z' },
      // YouTube re-counted on Jan 2 — running total dropped.
      { views: 950, ctr_percentage: null, average_view_percentage: null, captured_at: '2026-01-02T20:00:00Z' },
    ]);
    expect(out[1]!.views_gained).toBe(0);
  });

  it('preserves null CTR / AVP when source rows had them', () => {
    const out = bucketByDay([
      { views: 100, ctr_percentage: null, average_view_percentage: null, captured_at: '2026-01-01T12:00:00Z' },
    ]);
    expect(out[0]!.ctr_percentage).toBeNull();
    expect(out[0]!.average_view_percentage).toBeNull();
  });

  it('returns days in ascending order regardless of input order', () => {
    const out = bucketByDay([
      { views: 500, ctr_percentage: null, average_view_percentage: null, captured_at: '2026-01-03T12:00:00Z' },
      { views: 100, ctr_percentage: null, average_view_percentage: null, captured_at: '2026-01-01T12:00:00Z' },
      { views: 300, ctr_percentage: null, average_view_percentage: null, captured_at: '2026-01-02T12:00:00Z' },
    ]);
    expect(out.map((b) => b.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });
});

describe('percentileOfVelocity', () => {
  it('returns null for an empty population (cold-start channel)', () => {
    expect(percentileOfVelocity(100, [])).toBeNull();
  });

  it('returns 1.0 when value matches every entry in the population', () => {
    // 100 is >= every entry → 100th percentile.
    expect(percentileOfVelocity(100, [50, 80, 100])).toBe(1);
  });

  it('returns 0 when value is strictly below every entry', () => {
    // 10 is not >= any entry → 0/3.
    expect(percentileOfVelocity(10, [50, 80, 100])).toBe(0);
  });

  it('returns the fraction of entries ≤ value', () => {
    // 80 is >= [50, 80] (2 of 3) → 2/3.
    const p = percentileOfVelocity(80, [50, 80, 100]);
    expect(p).toBeCloseTo(2 / 3, 5);
  });

  it('a 10× outlier sits comfortably above the 90th percentile', () => {
    // 100 ordinary samples + one breakout. The breakout's percentile
    // should be 1.0 (above all 100 ordinary samples + matches itself).
    const ordinary = Array.from({ length: 100 }, (_, i) => 10 + i); // 10..109
    const breakout = 1000;
    const p = percentileOfVelocity(breakout, [...ordinary, breakout]);
    expect(p).toBe(1);
  });
});

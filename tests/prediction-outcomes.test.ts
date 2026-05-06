import { describe, expect, it } from 'vitest';
import {
  ACCURACY_BUCKETS,
  aggregateAccuracy,
  computeDeltaMetrics,
  interpolateCurve,
  parseDeltaMetrics,
  type DeltaMetrics,
} from '@/lib/prediction-outcomes';
import type { RetentionPoint } from '@/lib/retention-predictor-types';

describe('interpolateCurve', () => {
  const curve: RetentionPoint[] = [
    { position: 0, retention: 1 },
    { position: 0.5, retention: 0.5 },
    { position: 1, retention: 0 },
  ];

  it('returns the exact value at sample positions', () => {
    expect(interpolateCurve(curve, 0)).toBe(1);
    expect(interpolateCurve(curve, 0.5)).toBe(0.5);
    expect(interpolateCurve(curve, 1)).toBe(0);
  });

  it('linearly interpolates between samples', () => {
    expect(interpolateCurve(curve, 0.25)!).toBeCloseTo(0.75, 5);
    expect(interpolateCurve(curve, 0.75)!).toBeCloseTo(0.25, 5);
  });

  it('clamps positions outside the curve domain', () => {
    expect(interpolateCurve(curve, -0.5)).toBe(1);
    expect(interpolateCurve(curve, 2.0)).toBe(0);
  });

  it('returns null for an empty curve', () => {
    expect(interpolateCurve([], 0.5)).toBeNull();
  });

  it('returns the only sample for a single-point curve', () => {
    expect(interpolateCurve([{ position: 0.3, retention: 0.7 }], 0.5)).toBe(0.7);
  });
});

describe('computeDeltaMetrics', () => {
  it('reports zero MAE when predicted == actual exactly', () => {
    const same: RetentionPoint[] = [
      { position: 0, retention: 1 },
      { position: 0.5, retention: 0.6 },
      { position: 1, retention: 0.3 },
    ];
    const m = computeDeltaMetrics(same, same);
    expect(m.mae_pct).toBe(0);
    expect(m.biggest_miss_direction).toBe('none');
    // Still produces 11 samples — useful for the dashboard's bucket
    // aggregation even when this video was a perfect prediction.
    expect(m.per_segment_deltas).toHaveLength(11);
  });

  it('flags over-prediction when actual is consistently lower', () => {
    const predicted: RetentionPoint[] = [
      { position: 0, retention: 1 },
      { position: 1, retention: 0.5 },
    ];
    // Actual is 0.1 lower across the board.
    const actual: RetentionPoint[] = [
      { position: 0, retention: 0.9 },
      { position: 1, retention: 0.4 },
    ];
    const m = computeDeltaMetrics(predicted, actual);
    expect(m.biggest_miss_direction).toBe('over');
    // 0.1 → 10 percentage points everywhere.
    expect(m.mae_pct).toBeCloseTo(10, 1);
  });

  it('flags under-prediction when actual is consistently higher', () => {
    const predicted: RetentionPoint[] = [
      { position: 0, retention: 0.6 },
      { position: 1, retention: 0.2 },
    ];
    const actual: RetentionPoint[] = [
      { position: 0, retention: 0.7 },
      { position: 1, retention: 0.3 },
    ];
    const m = computeDeltaMetrics(predicted, actual);
    expect(m.biggest_miss_direction).toBe('under');
    expect(m.mae_pct).toBeCloseTo(10, 1);
  });

  it('locates the biggest miss at the correct position', () => {
    // Predicted is flat at 0.5; actual drops sharply at position 0.5
    // so the worst miss is right around 0.5.
    const predicted: RetentionPoint[] = [
      { position: 0, retention: 0.5 },
      { position: 1, retention: 0.5 },
    ];
    const actual: RetentionPoint[] = [
      { position: 0, retention: 0.5 },
      { position: 0.5, retention: 0.1 },
      { position: 1, retention: 0.5 },
    ];
    const m = computeDeltaMetrics(predicted, actual);
    // The biggest gap between flat 0.5 and the actual valley is at 0.5.
    expect(m.biggest_miss_at_pct).toBeCloseTo(0.5, 1);
    expect(m.biggest_miss_direction).toBe('over'); // we predicted too high vs the dip
  });

  it('returns degenerate metric when one curve is too sparse', () => {
    const sparse: RetentionPoint[] = [{ position: 0, retention: 1 }];
    const fine: RetentionPoint[] = [
      { position: 0, retention: 1 },
      { position: 1, retention: 0.5 },
    ];
    const m = computeDeltaMetrics(sparse, fine);
    expect(m.mae_pct).toBe(0);
    expect(m.per_segment_deltas).toEqual([]);
    expect(m.biggest_miss_direction).toBe('none');
  });

  it('per_segment_deltas covers every sample position 0.0..1.0', () => {
    const predicted: RetentionPoint[] = [
      { position: 0, retention: 1 },
      { position: 1, retention: 0.5 },
    ];
    const actual: RetentionPoint[] = [
      { position: 0, retention: 0.9 },
      { position: 1, retention: 0.4 },
    ];
    const m = computeDeltaMetrics(predicted, actual);
    const positions = m.per_segment_deltas.map((s) => s.position);
    expect(positions[0]).toBe(0);
    expect(positions[positions.length - 1]).toBe(1);
    expect(positions).toHaveLength(11);
  });

  it('handles wildly different curve sample densities (100-pt vs 3-pt)', () => {
    // Realistic case: actual curve from YouTube has 100 samples,
    // predicted has 3. Both are interpolated at fixed positions, so
    // density doesn't matter — but the contract should still hold.
    const dense: RetentionPoint[] = Array.from({ length: 100 }, (_, i) => ({
      position: i / 99,
      retention: Math.max(0, 1 - i / 99 * 0.7), // 1 → 0.3 linear
    }));
    const sparse: RetentionPoint[] = [
      { position: 0, retention: 1 },
      { position: 0.5, retention: 0.65 },
      { position: 1, retention: 0.3 },
    ];
    const m = computeDeltaMetrics(sparse, dense);
    expect(m.per_segment_deltas).toHaveLength(11);
    // The two curves describe approximately the same shape, so MAE
    // should be small (well under 5pp).
    expect(m.mae_pct).toBeLessThan(5);
  });
});

describe('aggregateAccuracy', () => {
  function metric(maePct: number, biases: Record<number, number> = {}): DeltaMetrics {
    // Build per_segment_deltas at 11 evenly spaced positions; default to a
    // flat positive bias unless overridden by `biases` (position → delta in
    // 0-1 units, e.g. 0.05 = +5pp).
    const per_segment_deltas = Array.from({ length: 11 }, (_, i) => {
      const position = i / 10;
      const delta = biases[i] ?? 0.05;
      return {
        position,
        predicted: 0.5,
        actual: 0.5 + delta,
        delta,
      };
    });
    return {
      mae_pct: maePct,
      biggest_miss_at_pct: 0.5,
      biggest_miss_direction: 'under',
      per_segment_deltas,
    };
  }

  it('returns an empty-state shape with zero outcomes', () => {
    const out = aggregateAccuracy([]);
    expect(out.outcome_count).toBe(0);
    expect(out.overall_mae_pct).toBeNull();
    expect(out.buckets).toHaveLength(ACCURACY_BUCKETS.length);
    expect(out.buckets.every((b) => b.outcome_count === 0)).toBe(true);
    expect(out.last_captured_at).toBeNull();
    expect(out.trend.every((t) => t.delta_pct === null)).toBe(true);
  });

  it('computes overall_mae_pct as the mean of per-outcome mae_pct', () => {
    const out = aggregateAccuracy([
      { delta_metrics: metric(4), captured_at: '2026-01-01T00:00:00Z' },
      { delta_metrics: metric(8), captured_at: '2026-01-02T00:00:00Z' },
      { delta_metrics: metric(12), captured_at: '2026-01-03T00:00:00Z' },
    ]);
    expect(out.overall_mae_pct).toBeCloseTo(8, 5);
  });

  it('aggregates per-bucket MAE + bias from the per-segment deltas', () => {
    const out = aggregateAccuracy([
      { delta_metrics: metric(5), captured_at: '2026-01-01T00:00:00Z' },
    ]);
    // Each segment had a +5pp delta, so MAE and bias both = 5pp in
    // every bucket, and every bucket got at least one contributing
    // outcome.
    for (const b of out.buckets) {
      expect(b.mae_pct).toBeCloseTo(5, 1);
      expect(b.bias_pct).toBeCloseTo(5, 1);
      expect(b.outcome_count).toBe(1);
    }
  });

  it('detects a regressing bucket via the trend split', () => {
    // Older outcomes had a small +1pp delta in the midroll; recent
    // outcomes have a +10pp delta there. Trend should show a positive
    // delta_pct for midroll = "getting worse".
    const small = metric(1, {
      4: 0.01, // pos 0.4 (midroll)
      5: 0.01, // pos 0.5 (midroll)
      6: 0.01, // pos 0.6 (midroll)
    });
    const big = metric(10, {
      4: 0.1,
      5: 0.1,
      6: 0.1,
    });
    const out = aggregateAccuracy([
      { delta_metrics: small, captured_at: '2026-01-01T00:00:00Z' },
      { delta_metrics: small, captured_at: '2026-01-02T00:00:00Z' },
      { delta_metrics: big, captured_at: '2026-01-10T00:00:00Z' },
      { delta_metrics: big, captured_at: '2026-01-11T00:00:00Z' },
    ]);
    const midroll = out.trend.find((t) => t.key === 'midroll')!;
    expect(midroll.delta_pct).not.toBeNull();
    expect(midroll.delta_pct!).toBeGreaterThan(0);
  });

  it('reports the most recent captured_at regardless of input order', () => {
    const out = aggregateAccuracy([
      { delta_metrics: metric(3), captured_at: '2026-01-02T00:00:00Z' },
      { delta_metrics: metric(3), captured_at: '2026-01-04T00:00:00Z' },
      { delta_metrics: metric(3), captured_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(out.last_captured_at).toBe('2026-01-04T00:00:00Z');
  });

  it('single-outcome state has null trend deltas (no older half to split)', () => {
    // Phase 8.6.2 — surfaces the case the dashboard re-headlines as
    // "first outcome captured." With one outcome, mid = floor(1/2) = 0,
    // so olderHalf is empty and every bucket's delta_pct is null.
    const out = aggregateAccuracy([
      { delta_metrics: metric(7), captured_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(out.outcome_count).toBe(1);
    expect(out.overall_mae_pct).toBeCloseTo(7, 5);
    for (const t of out.trend) {
      expect(t.delta_pct).toBeNull();
    }
    // The bucket aggregation should still reflect the single outcome.
    for (const b of out.buckets) {
      expect(b.outcome_count).toBe(1);
    }
  });
});

describe('parseDeltaMetrics (defensive JSONB parser)', () => {
  it('returns empty-state for non-objects', () => {
    expect(parseDeltaMetrics(null)).toEqual({
      mae_pct: 0,
      biggest_miss_at_pct: 0,
      biggest_miss_direction: 'none',
      per_segment_deltas: [],
    });
    expect(parseDeltaMetrics('not an object')).toEqual({
      mae_pct: 0,
      biggest_miss_at_pct: 0,
      biggest_miss_direction: 'none',
      per_segment_deltas: [],
    });
  });

  it('clamps mae_pct to [0, 100] when JSONB carries garbage', () => {
    const out = parseDeltaMetrics({
      mae_pct: -50,
      biggest_miss_at_pct: 0.3,
      biggest_miss_direction: 'over',
      per_segment_deltas: [],
    });
    expect(out.mae_pct).toBe(0);
    const huge = parseDeltaMetrics({
      mae_pct: 500,
      biggest_miss_at_pct: 0.3,
      biggest_miss_direction: 'over',
      per_segment_deltas: [],
    });
    expect(huge.mae_pct).toBe(100);
  });

  it('clamps position outside [0, 1] in stored segments', () => {
    const out = parseDeltaMetrics({
      mae_pct: 5,
      biggest_miss_at_pct: 7, // out of range — must clamp to 1
      biggest_miss_direction: 'under',
      per_segment_deltas: [
        { position: -0.2, predicted: 1.5, actual: -0.3, delta: 2.0 },
      ],
    });
    expect(out.biggest_miss_at_pct).toBe(1);
    expect(out.per_segment_deltas[0]).toEqual({
      position: 0,
      predicted: 1,
      actual: 0,
      delta: 1, // clamped to [-1, 1]
    });
  });

  it('drops NaN values from mae_pct and biggest_miss_at_pct', () => {
    const out = parseDeltaMetrics({
      mae_pct: Number.NaN,
      biggest_miss_at_pct: Number.POSITIVE_INFINITY,
      biggest_miss_direction: 'totally-bogus',
      per_segment_deltas: 'also-bogus',
    });
    expect(out.mae_pct).toBe(0);
    expect(out.biggest_miss_at_pct).toBe(0);
    // Bogus direction → fall through to 'none'.
    expect(out.biggest_miss_direction).toBe('none');
    // Non-array segments → empty array.
    expect(out.per_segment_deltas).toEqual([]);
  });
});

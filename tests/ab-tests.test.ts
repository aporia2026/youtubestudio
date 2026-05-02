import { describe, expect, it } from 'vitest';
import {
  summariseAbTestSnapshots,
  validateVariantInputs,
} from '@/lib/ab-tests';
import {
  AB_TEST_TITLE_MAX_LENGTH,
  isAbTestVariant,
  type AbTestSnapshotRow,
} from '@/lib/ab-tests-types';

describe('isAbTestVariant', () => {
  it('accepts the literal "a" or "b"', () => {
    expect(isAbTestVariant('a')).toBe(true);
    expect(isAbTestVariant('b')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isAbTestVariant('A')).toBe(false);
    expect(isAbTestVariant('c')).toBe(false);
    expect(isAbTestVariant('')).toBe(false);
    expect(isAbTestVariant(null)).toBe(false);
    expect(isAbTestVariant(undefined)).toBe(false);
    expect(isAbTestVariant(0)).toBe(false);
    expect(isAbTestVariant({})).toBe(false);
  });
});

describe('validateVariantInputs', () => {
  it('trims + returns valid distinct titles', () => {
    const out = validateVariantInputs({
      variantATitle: '  How I learned to code in 30 days  ',
      variantBTitle: 'Coding in 30 days: my honest results',
    });
    expect(out.variantATitle).toBe('How I learned to code in 30 days');
    expect(out.variantBTitle).toBe('Coding in 30 days: my honest results');
    expect(out.variantAThumbnailUrl).toBeNull();
    expect(out.variantBThumbnailUrl).toBeNull();
  });

  it('rejects blank titles', () => {
    expect(() => validateVariantInputs({ variantATitle: '', variantBTitle: 'B' })).toThrow(/required/);
    expect(() => validateVariantInputs({ variantATitle: 'A', variantBTitle: '   ' })).toThrow(/required/);
  });

  it('rejects identical titles', () => {
    expect(() =>
      validateVariantInputs({ variantATitle: 'Same title', variantBTitle: 'Same title' }),
    ).toThrow(/identical/);
  });

  it('rejects titles over the YouTube 100-char limit', () => {
    const huge = 'x'.repeat(AB_TEST_TITLE_MAX_LENGTH + 1);
    expect(() => validateVariantInputs({ variantATitle: huge, variantBTitle: 'B' })).toThrow(/100-character/);
  });

  it('passes through thumbnail URLs (trimmed) and nullifies empty ones', () => {
    const out = validateVariantInputs({
      variantATitle: 'A title',
      variantBTitle: 'B title',
      variantAThumbnailUrl: '  https://example.com/a.jpg  ',
      variantBThumbnailUrl: '',
    });
    expect(out.variantAThumbnailUrl).toBe('https://example.com/a.jpg');
    expect(out.variantBThumbnailUrl).toBeNull();
  });
});

describe('summariseAbTestSnapshots', () => {
  function snap(
    variant: 'a' | 'b',
    captured_at: string,
    overrides: Partial<AbTestSnapshotRow> = {},
  ): AbTestSnapshotRow {
    return {
      id: `${variant}-${captured_at}`,
      workspace_id: 'ws',
      ab_test_id: 'test',
      variant,
      captured_at,
      impressions: 1000,
      views: 100,
      ctr_percentage: 10,
      average_view_duration_seconds: 120,
      average_view_percentage: 50,
      subscribers_gained: 5,
      raw: {},
      ...overrides,
    };
  }

  it('returns zeroed summaries when there are no snapshots', () => {
    const out = summariseAbTestSnapshots([]);
    expect(out.a.snapshot_count).toBe(0);
    expect(out.a.impressions).toBeNull();
    expect(out.a.ctr_percentage).toBeNull();
    expect(out.b.snapshot_count).toBe(0);
  });

  it('counts snapshots and keeps the latest per variant', () => {
    const out = summariseAbTestSnapshots([
      snap('a', '2026-05-01T00:00:00Z', { impressions: 100, views: 5, ctr_percentage: 5 }),
      snap('a', '2026-05-02T00:00:00Z', { impressions: 200, views: 12, ctr_percentage: 6 }),
      snap('b', '2026-05-03T00:00:00Z', { impressions: 300, views: 24, ctr_percentage: 8 }),
    ]);
    expect(out.a.snapshot_count).toBe(2);
    expect(out.a.impressions).toBe(200);
    expect(out.a.views).toBe(12);
    expect(out.a.ctr_percentage).toBe(6);
    expect(out.a.latest_captured_at).toBe('2026-05-02T00:00:00Z');
    expect(out.b.snapshot_count).toBe(1);
    expect(out.b.impressions).toBe(300);
    expect(out.b.ctr_percentage).toBe(8);
  });

  it('is order-independent (handles snapshots passed in reverse chronological order)', () => {
    const out = summariseAbTestSnapshots([
      snap('a', '2026-05-02T00:00:00Z', { impressions: 200 }),
      snap('a', '2026-05-01T00:00:00Z', { impressions: 100 }),
    ]);
    expect(out.a.impressions).toBe(200);
    expect(out.a.latest_captured_at).toBe('2026-05-02T00:00:00Z');
  });

  it('preserves null analytics fields from the latest snapshot', () => {
    const out = summariseAbTestSnapshots([
      snap('a', '2026-05-01T00:00:00Z', {
        impressions: 100,
        ctr_percentage: 5,
      }),
      snap('a', '2026-05-02T00:00:00Z', {
        impressions: null,
        ctr_percentage: null,
        views: 50,
      }),
    ]);
    // Latest wins, even when its fields are null — we don't lie by carrying
    // forward stale impressions data.
    expect(out.a.impressions).toBeNull();
    expect(out.a.ctr_percentage).toBeNull();
    expect(out.a.views).toBe(50);
  });
});

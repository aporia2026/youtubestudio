/**
 * Pure-helper tests for the outlier filter / preset machinery.
 *
 *   - Bucket helpers (duration / channel size / title length) hit
 *     the documented thresholds + edge cases.
 *   - filterAndSortOutliers applies each dimension independently
 *     and in combination, and respects every sort order.
 *   - computeConsistentWinners flags channels with N+ hits.
 *   - Built-in presets are well-formed.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketDuration,
  bucketChannelSize,
  bucketTitleLength,
  computeConsistentWinners,
  filterAndSortOutliers,
  BUILTIN_OUTLIER_PRESETS,
  getBuiltinPreset,
  DEFAULT_FILTERS,
  type OutlierFilters,
} from '@/lib/niche-finder/outlier-filters';
import {
  normalizePresetName,
  PRESET_NAME_MAX_LENGTH,
} from '@/lib/niche-finder/presets-db';
import type { OutlierVideo } from '@/lib/niche-finder/outliers';

// Frozen "now" for deterministic publishedWithinDays tests.
const NOW = Date.parse('2026-05-13T00:00:00Z');

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
}

function v(partial: Partial<OutlierVideo>): OutlierVideo {
  return {
    videoId: 'v',
    channelId: 'c',
    title: 'A reasonable title',
    viewCount: 100_000,
    publishedAt: isoDaysAgo(10),
    durationIso: 'PT5M',
    thumbnailUrl: null,
    channelTitle: 'Channel',
    subscriberCount: 50_000,
    outlierScore: 2,
    classification: 'normal',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

describe('bucketDuration', () => {
  it('classifies short (≤60s)', () => {
    expect(bucketDuration('PT30S')).toBe('short');
    expect(bucketDuration('PT60S')).toBe('short');
    expect(bucketDuration('PT1M')).toBe('short');
  });
  it('classifies normal (60s < d < 8min)', () => {
    expect(bucketDuration('PT2M')).toBe('normal');
    expect(bucketDuration('PT7M59S')).toBe('normal');
  });
  it('classifies long-form (≥8min)', () => {
    expect(bucketDuration('PT8M')).toBe('long');
    expect(bucketDuration('PT1H')).toBe('long');
  });
  it('falls back to normal for unparseable input', () => {
    expect(bucketDuration('garbage')).toBe('normal');
    expect(bucketDuration('')).toBe('normal');
  });
});

describe('bucketChannelSize', () => {
  it('classifies tiny (<10K)', () => {
    expect(bucketChannelSize(0)).toBe('tiny');
    expect(bucketChannelSize(9_999)).toBe('tiny');
  });
  it('classifies small (10K-100K)', () => {
    expect(bucketChannelSize(10_000)).toBe('small');
    expect(bucketChannelSize(99_999)).toBe('small');
  });
  it('classifies mid (100K-1M)', () => {
    expect(bucketChannelSize(100_000)).toBe('mid');
    expect(bucketChannelSize(999_999)).toBe('mid');
  });
  it('classifies large (1M+)', () => {
    expect(bucketChannelSize(1_000_000)).toBe('large');
    expect(bucketChannelSize(50_000_000)).toBe('large');
  });
  it('handles non-finite input as tiny', () => {
    expect(bucketChannelSize(Number.NaN)).toBe('tiny');
    expect(bucketChannelSize(-100)).toBe('tiny');
  });
});

describe('bucketTitleLength', () => {
  it('classifies punchy (≤40)', () => {
    expect(bucketTitleLength('Short')).toBe('punchy');
    expect(bucketTitleLength('a'.repeat(40))).toBe('punchy');
  });
  it('classifies medium (41-70)', () => {
    expect(bucketTitleLength('a'.repeat(45))).toBe('medium');
    expect(bucketTitleLength('a'.repeat(70))).toBe('medium');
  });
  it('classifies descriptive (>70)', () => {
    expect(bucketTitleLength('a'.repeat(80))).toBe('descriptive');
  });
  it('trims before measuring', () => {
    expect(bucketTitleLength('   Short   ')).toBe('punchy');
  });
  it('handles non-string input as punchy', () => {
    // @ts-expect-error intentionally wrong type
    expect(bucketTitleLength(undefined)).toBe('punchy');
  });
});

// ---------------------------------------------------------------------------
// Consistent-winners detection
// ---------------------------------------------------------------------------

describe('computeConsistentWinners', () => {
  it('flags a channel with ≥3 hits', () => {
    const videos = [
      v({ channelId: 'A', videoId: 'a1' }),
      v({ channelId: 'A', videoId: 'a2' }),
      v({ channelId: 'A', videoId: 'a3' }),
      v({ channelId: 'B', videoId: 'b1' }),
    ];
    const winners = computeConsistentWinners(videos);
    expect(winners.has('A')).toBe(true);
    expect(winners.has('B')).toBe(false);
  });

  it('respects a custom threshold', () => {
    const videos = [v({ channelId: 'A', videoId: 'a1' }), v({ channelId: 'A', videoId: 'a2' })];
    expect(computeConsistentWinners(videos, 2).has('A')).toBe(true);
    expect(computeConsistentWinners(videos, 3).has('A')).toBe(false);
  });

  it('handles empty input', () => {
    expect(computeConsistentWinners([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// filterAndSortOutliers — each filter independently
// ---------------------------------------------------------------------------

describe('filterAndSortOutliers', () => {
  it('returns empty for empty input', () => {
    expect(filterAndSortOutliers([], DEFAULT_FILTERS, NOW)).toEqual([]);
  });

  it('returns the full set (sorted by outlier) when filters are empty', () => {
    const videos = [
      v({ videoId: '1', outlierScore: 2 }),
      v({ videoId: '2', outlierScore: 5 }),
      v({ videoId: '3', outlierScore: 1 }),
    ];
    const out = filterAndSortOutliers(videos, DEFAULT_FILTERS, NOW);
    expect(out.map((x) => x.videoId)).toEqual(['2', '1', '3']);
  });

  it('filters by format', () => {
    const videos = [
      v({ videoId: 'short', durationIso: 'PT30S' }),
      v({ videoId: 'normal', durationIso: 'PT5M' }),
      v({ videoId: 'long', durationIso: 'PT15M' }),
    ];
    const shorts = filterAndSortOutliers(videos, { formats: ['short'] }, NOW);
    expect(shorts.map((x) => x.videoId)).toEqual(['short']);
    const longAndNormal = filterAndSortOutliers(videos, { formats: ['normal', 'long'] }, NOW);
    expect(longAndNormal.map((x) => x.videoId).sort()).toEqual(['long', 'normal'].sort());
  });

  it('filters by channel size', () => {
    const videos = [
      v({ videoId: 'tiny', subscriberCount: 500 }),
      v({ videoId: 'small', subscriberCount: 50_000 }),
      v({ videoId: 'mid', subscriberCount: 500_000 }),
      v({ videoId: 'large', subscriberCount: 5_000_000 }),
    ];
    const tinyOnly = filterAndSortOutliers(videos, { channelSizes: ['tiny'] }, NOW);
    expect(tinyOnly.map((x) => x.videoId)).toEqual(['tiny']);
  });

  it('filters by min views', () => {
    const videos = [
      v({ videoId: 'lo', viewCount: 5_000 }),
      v({ videoId: 'mid', viewCount: 50_000 }),
      v({ videoId: 'hi', viewCount: 5_000_000 }),
    ];
    const big = filterAndSortOutliers(videos, { minViews: 100_000 }, NOW);
    expect(big.map((x) => x.videoId)).toEqual(['hi']);
  });

  it('filters by published window', () => {
    const videos = [
      v({ videoId: 'recent', publishedAt: isoDaysAgo(3) }),
      v({ videoId: 'older', publishedAt: isoDaysAgo(60) }),
      v({ videoId: 'ancient', publishedAt: isoDaysAgo(400) }),
    ];
    const recent = filterAndSortOutliers(videos, { publishedWithinDays: 7 }, NOW);
    expect(recent.map((x) => x.videoId)).toEqual(['recent']);
  });

  it('filters by min outlier score', () => {
    const videos = [
      v({ videoId: 'a', outlierScore: 0.5 }),
      v({ videoId: 'b', outlierScore: 5 }),
      v({ videoId: 'c', outlierScore: 12 }),
    ];
    const viral = filterAndSortOutliers(videos, { minOutlierScore: 10 }, NOW);
    expect(viral.map((x) => x.videoId)).toEqual(['c']);
  });

  it('filters by title length bucket', () => {
    const videos = [
      v({ videoId: 'short', title: 'Short' }),
      v({ videoId: 'long', title: 'a'.repeat(100) }),
    ];
    const punchy = filterAndSortOutliers(videos, { titleLengths: ['punchy'] }, NOW);
    expect(punchy.map((x) => x.videoId)).toEqual(['short']);
  });

  it('filters by consistentWinnersOnly', () => {
    const videos = [
      v({ channelId: 'A', videoId: 'a1' }),
      v({ channelId: 'A', videoId: 'a2' }),
      v({ channelId: 'A', videoId: 'a3' }),
      v({ channelId: 'B', videoId: 'b1' }),
    ];
    const out = filterAndSortOutliers(videos, { consistentWinnersOnly: true }, NOW);
    expect(out.every((x) => x.channelId === 'A')).toBe(true);
    expect(out).toHaveLength(3);
  });

  it('composes multiple filters', () => {
    const videos = [
      v({ videoId: 'a', durationIso: 'PT15M', subscriberCount: 50_000, outlierScore: 5 }),
      v({ videoId: 'b', durationIso: 'PT5M', subscriberCount: 50_000, outlierScore: 5 }),
      v({ videoId: 'c', durationIso: 'PT15M', subscriberCount: 5_000_000, outlierScore: 5 }),
    ];
    const out = filterAndSortOutliers(
      videos,
      { formats: ['long'], channelSizes: ['small'], minOutlierScore: 3 },
      NOW,
    );
    expect(out.map((x) => x.videoId)).toEqual(['a']);
  });

  it('sorts by views', () => {
    const videos = [
      v({ videoId: 'lo', viewCount: 1_000 }),
      v({ videoId: 'hi', viewCount: 1_000_000 }),
      v({ videoId: 'mid', viewCount: 100_000 }),
    ];
    const out = filterAndSortOutliers(videos, { sortBy: 'views' }, NOW);
    expect(out.map((x) => x.videoId)).toEqual(['hi', 'mid', 'lo']);
  });

  it('sorts by subs ascending', () => {
    const videos = [
      v({ videoId: 'big', subscriberCount: 1_000_000 }),
      v({ videoId: 'small', subscriberCount: 1_000 }),
      v({ videoId: 'mid', subscriberCount: 100_000 }),
    ];
    const out = filterAndSortOutliers(videos, { sortBy: 'subsAsc' }, NOW);
    expect(out.map((x) => x.videoId)).toEqual(['small', 'mid', 'big']);
  });

  it('sorts by newest', () => {
    const videos = [
      v({ videoId: 'old', publishedAt: isoDaysAgo(100) }),
      v({ videoId: 'new', publishedAt: isoDaysAgo(1) }),
      v({ videoId: 'mid', publishedAt: isoDaysAgo(30) }),
    ];
    const out = filterAndSortOutliers(videos, { sortBy: 'newest' }, NOW);
    expect(out.map((x) => x.videoId)).toEqual(['new', 'mid', 'old']);
  });

  it('sorts by title shortest', () => {
    const videos = [
      v({ videoId: 'long', title: 'a'.repeat(100) }),
      v({ videoId: 'short', title: 'Hi' }),
      v({ videoId: 'mid', title: 'Medium length title here' }),
    ];
    const out = filterAndSortOutliers(videos, { sortBy: 'titleShortest' }, NOW);
    expect(out.map((x) => x.videoId)).toEqual(['short', 'mid', 'long']);
  });

  it('treats an all-options set as no filter (perf optimisation)', () => {
    const videos = [
      v({ videoId: 'a', durationIso: 'PT30S' }),
      v({ videoId: 'b', durationIso: 'PT5M' }),
      v({ videoId: 'c', durationIso: 'PT15M' }),
    ];
    const out = filterAndSortOutliers(
      videos,
      { formats: ['short', 'normal', 'long'] },
      NOW,
    );
    // All three included; formats filter set to all = effectively
    // no constraint.
    expect(out).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

describe('BUILTIN_OUTLIER_PRESETS', () => {
  it('exposes nine presets', () => {
    expect(BUILTIN_OUTLIER_PRESETS).toHaveLength(9);
  });

  it('every preset has a unique id', () => {
    const ids = new Set(BUILTIN_OUTLIER_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(BUILTIN_OUTLIER_PRESETS.length);
  });

  it('every preset has a description', () => {
    for (const p of BUILTIN_OUTLIER_PRESETS) {
      expect(p.description.trim().length).toBeGreaterThan(10);
    }
  });

  it('every preset has a non-empty filter set', () => {
    for (const p of BUILTIN_OUTLIER_PRESETS) {
      const keys = Object.keys(p.filters as Record<string, unknown>);
      expect(keys.length).toBeGreaterThan(0);
    }
  });

  it('getBuiltinPreset returns matching preset', () => {
    expect(getBuiltinPreset('breakout-shorts')?.label).toBe('Breakout shorts');
    expect(getBuiltinPreset('does-not-exist')).toBeUndefined();
  });

  it('every preset survives a round-trip through filterAndSortOutliers without throwing', () => {
    const videos = Array.from({ length: 5 }, (_, i) =>
      v({ videoId: `v${i}`, outlierScore: i + 1, viewCount: 10_000 * (i + 1) }),
    );
    for (const p of BUILTIN_OUTLIER_PRESETS) {
      expect(() => filterAndSortOutliers(videos, p.filters as OutlierFilters, NOW)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Saved-preset name normalisation
// ---------------------------------------------------------------------------

describe('normalizePresetName', () => {
  it('trims + collapses whitespace', () => {
    expect(normalizePresetName('  My  Search  ')).toBe('My Search');
  });

  it('returns null for empty / non-string', () => {
    expect(normalizePresetName('')).toBeNull();
    expect(normalizePresetName('   ')).toBeNull();
    expect(normalizePresetName(null)).toBeNull();
    expect(normalizePresetName(undefined)).toBeNull();
    expect(normalizePresetName(42)).toBeNull();
  });

  it('caps at PRESET_NAME_MAX_LENGTH', () => {
    const huge = 'a'.repeat(200);
    expect(normalizePresetName(huge)?.length).toBe(PRESET_NAME_MAX_LENGTH);
  });
});

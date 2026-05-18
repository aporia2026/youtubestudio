/**
 * Pure-helper tests for mode D (outliers).
 *
 * The fetch-bound `findOutliers` is exercised by the route smoke
 * path; these tests cover the deterministic math + classification.
 */
import { describe, expect, it } from 'vitest';
import {
  computeOutlierScore,
  classifyOutlierScore,
  buildOutliers,
  buildOutlierQueryVariants,
  OUTLIER_SUB_FLOOR,
} from '@/lib/niche-finder/outliers';
import type { FetchedChannel, FetchedVideo } from '@/lib/niche-finder/youtube-fetch';

function v(partial: Partial<FetchedVideo>): FetchedVideo {
  return {
    id: 'v',
    channelId: 'c',
    title: 'video',
    description: '',
    viewCount: 1000,
    publishedAt: '2026-01-01T00:00:00Z',
    durationIso: 'PT5M',
    tags: [],
    thumbnailUrl: null,
    defaultLanguage: null,
    defaultAudioLanguage: null,
    ...partial,
  };
}

function ch(partial: Partial<FetchedChannel>): FetchedChannel {
  return {
    id: 'c',
    title: 'Channel',
    subscriberCount: 10_000,
    videoCount: 100,
    createdAt: null,
    thumbnailUrl: null,
    ...partial,
  };
}

describe('computeOutlierScore', () => {
  it('returns views/subs when subs above floor', () => {
    expect(computeOutlierScore(10_000, 10_000)).toBe(1);
    expect(computeOutlierScore(50_000, 10_000)).toBe(5);
  });

  it('uses the sub floor when subs are tiny', () => {
    // 100 subs → effective denominator is OUTLIER_SUB_FLOOR (1000).
    expect(computeOutlierScore(10_000, 100)).toBe(10_000 / OUTLIER_SUB_FLOOR);
  });

  it('handles zero subs gracefully', () => {
    expect(computeOutlierScore(10_000, 0)).toBe(10_000 / OUTLIER_SUB_FLOOR);
  });

  it('returns 0 for negative or non-finite views', () => {
    expect(computeOutlierScore(-100, 10_000)).toBe(0);
    expect(computeOutlierScore(Number.NaN, 10_000)).toBe(0);
  });

  it('returns 0 for non-finite subs (clamps to floor)', () => {
    // Non-finite subs collapse to the floor.
    expect(computeOutlierScore(10_000, Number.NaN)).toBe(10_000 / OUTLIER_SUB_FLOOR);
  });
});

describe('classifyOutlierScore', () => {
  it('boundaries match the documented thresholds', () => {
    expect(classifyOutlierScore(0)).toBe('underperformer');
    expect(classifyOutlierScore(0.5)).toBe('underperformer');
    expect(classifyOutlierScore(1)).toBe('normal');
    expect(classifyOutlierScore(2.9)).toBe('normal');
    expect(classifyOutlierScore(3)).toBe('breakout');
    expect(classifyOutlierScore(9.99)).toBe('breakout');
    expect(classifyOutlierScore(10)).toBe('viral');
    expect(classifyOutlierScore(1000)).toBe('viral');
  });

  it('handles non-finite scores as underperformer', () => {
    expect(classifyOutlierScore(Number.NaN)).toBe('underperformer');
    expect(classifyOutlierScore(-5)).toBe('underperformer');
  });
});

describe('buildOutliers', () => {
  it('sorts by outlierScore descending', () => {
    const videos = [
      v({ id: 'small', channelId: 'big', viewCount: 1_000 }),
      v({ id: 'big', channelId: 'small', viewCount: 1_000_000 }),
      v({ id: 'medium', channelId: 'big', viewCount: 100_000 }),
    ];
    const channels = [
      ch({ id: 'big', subscriberCount: 1_000_000, title: 'Big Channel' }),
      ch({ id: 'small', subscriberCount: 5_000, title: 'Small Channel' }),
    ];
    const out = buildOutliers(videos, channels);
    expect(out[0].videoId).toBe('big');
    expect(out[0].classification).toBe('viral');
  });

  it('uses sub floor when channel is missing or tiny', () => {
    const videos = [v({ id: 'unknown', channelId: 'ghost', viewCount: 100_000 })];
    const channels: FetchedChannel[] = [];
    const out = buildOutliers(videos, channels);
    expect(out).toHaveLength(1);
    expect(out[0].subscriberCount).toBe(0);
    expect(out[0].channelTitle).toBe('Unknown channel');
    // Effective denominator should be OUTLIER_SUB_FLOOR.
    expect(out[0].outlierScore).toBeCloseTo(100_000 / OUTLIER_SUB_FLOOR, 1);
  });

  it('classifies every video', () => {
    const videos = [
      v({ id: 'a', viewCount: 500, channelId: 'c1' }),
      v({ id: 'b', viewCount: 50_000, channelId: 'c1' }),
      v({ id: 'c', viewCount: 5_000_000, channelId: 'c1' }),
    ];
    const channels = [ch({ id: 'c1', subscriberCount: 10_000 })];
    const out = buildOutliers(videos, channels);
    expect(out.map((o) => o.classification).sort()).toEqual(
      ['breakout', 'underperformer', 'viral'].sort(),
    );
  });

  it('returns empty array for empty input', () => {
    expect(buildOutliers([], [])).toEqual([]);
  });
});

describe('buildOutlierQueryVariants', () => {
  const currentYear = String(new Date().getFullYear());

  it('returns bare + "best X" + "X <year>" for a plain niche', () => {
    const out = buildOutlierQueryVariants('watercolor painting');
    expect(out).toEqual([
      'watercolor painting',
      'best watercolor painting',
      `watercolor painting ${currentYear}`,
    ]);
  });

  it('trims the input before variant generation', () => {
    expect(buildOutlierQueryVariants('  yoga  ')).toEqual([
      'yoga',
      'best yoga',
      `yoga ${currentYear}`,
    ]);
  });

  it('skips the "best" variant when the niche already starts with "best"', () => {
    const out = buildOutlierQueryVariants('best espresso machines');
    expect(out).toEqual(['best espresso machines', `best espresso machines ${currentYear}`]);
  });

  it('is case-insensitive on the "best" guard', () => {
    const out = buildOutlierQueryVariants('Best Hiking Gear');
    expect(out).toEqual(['Best Hiking Gear', `Best Hiking Gear ${currentYear}`]);
  });

  it('skips the year variant when the niche already contains the current year', () => {
    const niche = `top albums ${currentYear}`;
    const out = buildOutlierQueryVariants(niche);
    expect(out).toEqual([niche, `best ${niche}`]);
  });

  it('returns an empty list for an empty or whitespace-only niche', () => {
    expect(buildOutlierQueryVariants('')).toEqual([]);
    expect(buildOutlierQueryVariants('   ')).toEqual([]);
  });
});

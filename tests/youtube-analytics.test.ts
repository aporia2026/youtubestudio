import { describe, expect, it } from 'vitest';
import {
  parseDataApiResponse,
  parseAnalyticsRow,
  parseRetentionRows,
  parseIso8601Duration,
  chooseDataSource,
  type DataApiSnapshot,
  type AnalyticsApiSnapshot,
} from '@/lib/youtube-analytics';

describe('parseIso8601Duration', () => {
  it('parses common formats', () => {
    expect(parseIso8601Duration('PT0S')).toBe(0);
    expect(parseIso8601Duration('PT1S')).toBe(1);
    expect(parseIso8601Duration('PT1M')).toBe(60);
    expect(parseIso8601Duration('PT1H')).toBe(3600);
    expect(parseIso8601Duration('PT4M13S')).toBe(253);
    expect(parseIso8601Duration('PT1H2M3S')).toBe(3723);
    expect(parseIso8601Duration('PT12H30M')).toBe(45000);
  });

  it('returns null for malformed / non-ISO inputs', () => {
    expect(parseIso8601Duration(undefined)).toBeNull();
    expect(parseIso8601Duration(null)).toBeNull();
    expect(parseIso8601Duration('')).toBeNull();
    expect(parseIso8601Duration('4M13S')).toBeNull(); // missing PT prefix
    expect(parseIso8601Duration('PT')).toBeNull(); // empty body
    expect(parseIso8601Duration('not-a-duration')).toBeNull();
  });
});

describe('parseDataApiResponse', () => {
  it('extracts the first item\'s public stats', () => {
    const result = parseDataApiResponse({
      items: [
        {
          id: 'abc123',
          snippet: {
            title: 'My Video',
            publishedAt: '2026-04-01T10:00:00Z',
            thumbnails: {
              maxres: { url: 'https://example.com/maxres.jpg' },
              high: { url: 'https://example.com/high.jpg' },
            },
          },
          statistics: {
            viewCount: '12345',
            likeCount: '678',
            commentCount: '90',
          },
          contentDetails: { duration: 'PT4M13S' },
        },
      ],
    });
    expect(result).toEqual({
      views: 12345,
      likes: 678,
      comments: 90,
      duration_seconds: 253,
      published_at: '2026-04-01T10:00:00Z',
      title: 'My Video',
      thumbnail_url: 'https://example.com/maxres.jpg',
    });
  });

  it('falls back through thumbnail sizes (maxres → high → medium → default)', () => {
    expect(
      parseDataApiResponse({
        items: [{ snippet: { thumbnails: { high: { url: 'h' }, default: { url: 'd' } } } }],
      }).thumbnail_url,
    ).toBe('h');
    expect(
      parseDataApiResponse({
        items: [{ snippet: { thumbnails: { default: { url: 'd' } } } }],
      }).thumbnail_url,
    ).toBe('d');
  });

  it('returns nulls for empty / missing fields', () => {
    expect(parseDataApiResponse({ items: [] })).toEqual({
      views: null,
      likes: null,
      comments: null,
      duration_seconds: null,
      published_at: null,
      title: null,
      thumbnail_url: null,
    });
    expect(parseDataApiResponse({ items: [{}] }).views).toBeNull();
    expect(parseDataApiResponse(null).views).toBeNull();
    expect(parseDataApiResponse('not an object').views).toBeNull();
  });

  it('handles numeric stats already as numbers (not just strings)', () => {
    const r = parseDataApiResponse({
      items: [{ statistics: { viewCount: 100, likeCount: 5, commentCount: 0 } }],
    });
    expect(r.views).toBe(100);
    expect(r.likes).toBe(5);
    expect(r.comments).toBe(0);
  });

  it('drops non-numeric stat values silently', () => {
    const r = parseDataApiResponse({
      items: [{ statistics: { viewCount: 'NaN-ish-thing', likeCount: undefined } }],
    });
    expect(r.views).toBeNull();
    expect(r.likes).toBeNull();
  });
});

describe('parseAnalyticsRow', () => {
  it('reads a well-formed Analytics API response', () => {
    const r = parseAnalyticsRow({
      columnHeaders: [
        { name: 'video' },
        { name: 'impressions' },
        { name: 'impressionsCtr' },
        { name: 'averageViewDuration' },
        { name: 'averageViewPercentage' },
        { name: 'subscribersGained' },
      ],
      rows: [['vid-1', 50000, 0.0734, 245, 38.2, 12]],
    });
    expect(r.impressions).toBe(50000);
    expect(r.ctr_percentage).toBeCloseTo(7.34, 2); // 0.0734 → 7.34%
    expect(r.average_view_duration_seconds).toBe(245);
    expect(r.average_view_percentage).toBe(38.2);
    expect(r.subscribers_gained).toBe(12);
  });

  it('treats CTR > 1 as already a percent (does not double-multiply)', () => {
    const r = parseAnalyticsRow({
      columnHeaders: [{ name: 'impressionsCtr' }],
      rows: [[8.5]],
    });
    expect(r.ctr_percentage).toBe(8.5);
  });

  it('returns nulls when there are no rows', () => {
    expect(
      parseAnalyticsRow({
        columnHeaders: [{ name: 'impressions' }],
        rows: [],
      }),
    ).toEqual({
      impressions: null,
      ctr_percentage: null,
      average_view_duration_seconds: null,
      average_view_percentage: null,
      subscribers_gained: null,
    });
  });

  it('returns nulls for malformed responses', () => {
    expect(parseAnalyticsRow(null).impressions).toBeNull();
    expect(parseAnalyticsRow({}).impressions).toBeNull();
    expect(parseAnalyticsRow({ columnHeaders: 'oops' }).impressions).toBeNull();
  });
});

describe('parseRetentionRows', () => {
  it('reads retention curve rows', () => {
    const r = parseRetentionRows({
      columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }],
      rows: [
        [0, 1],
        [0.5, 0.62],
        [1, 0.31],
      ],
    });
    expect(r).toEqual([
      { position: 0, retention: 1 },
      { position: 0.5, retention: 0.62 },
      { position: 1, retention: 0.31 },
    ]);
  });

  it('drops non-numeric rows', () => {
    const r = parseRetentionRows({
      columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }],
      rows: [
        [0, 1],
        ['nope', 'nope'],
        [0.5, 0.5],
      ],
    });
    expect(r).toEqual([
      { position: 0, retention: 1 },
      { position: 0.5, retention: 0.5 },
    ]);
  });

  it('returns null when the response shape is wrong', () => {
    expect(parseRetentionRows(null)).toBeNull();
    expect(parseRetentionRows({})).toBeNull();
    expect(
      parseRetentionRows({
        columnHeaders: [{ name: 'wrongColumn' }],
        rows: [[1]],
      }),
    ).toBeNull();
  });

  it('returns null when the rows are all unparseable', () => {
    expect(
      parseRetentionRows({
        columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }],
        rows: [['x', 'y']],
      }),
    ).toBeNull();
  });
});

describe('chooseDataSource', () => {
  const dataSnap: DataApiSnapshot = {
    views: 1,
    likes: 1,
    comments: 1,
    duration_seconds: 100,
    published_at: '2026-01-01T00:00:00Z',
    title: 't',
    thumbnail_url: 'u',
  };
  const emptyData: DataApiSnapshot = {
    views: null,
    likes: null,
    comments: null,
    duration_seconds: null,
    published_at: null,
    title: null,
    thumbnail_url: null,
  };
  const analyticsSnap: AnalyticsApiSnapshot = {
    impressions: 100,
    ctr_percentage: 7,
    average_view_duration_seconds: 200,
    average_view_percentage: 50,
    subscribers_gained: 5,
  };
  const emptyAnalytics: AnalyticsApiSnapshot = {
    impressions: null,
    ctr_percentage: null,
    average_view_duration_seconds: null,
    average_view_percentage: null,
    subscribers_gained: null,
  };

  it('returns "mixed" when both APIs returned data', () => {
    expect(chooseDataSource(dataSnap, analyticsSnap, null, true)).toBe('mixed');
  });

  it('returns "data" when only Data API returned values', () => {
    expect(chooseDataSource(dataSnap, emptyAnalytics, null, true)).toBe('data');
    expect(chooseDataSource(dataSnap, emptyAnalytics, null, false)).toBe('data');
  });

  it('returns "analytics" when only Analytics returned values (rare)', () => {
    expect(chooseDataSource(emptyData, analyticsSnap, null, true)).toBe('analytics');
  });

  it('returns "partial" when nothing came back', () => {
    expect(chooseDataSource(emptyData, emptyAnalytics, null, false)).toBe('partial');
    expect(chooseDataSource(emptyData, emptyAnalytics, null, true)).toBe('partial');
  });

  it('counts retention curve as analytics evidence', () => {
    expect(
      chooseDataSource(
        dataSnap,
        emptyAnalytics,
        [{ position: 0, retention: 1 }],
        true,
      ),
    ).toBe('mixed');
  });
});

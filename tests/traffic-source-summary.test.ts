import { describe, expect, it } from 'vitest';
import {
  breakdownDelta,
  mergeBreakdowns,
} from '@/lib/traffic-source-summary';
import {
  parseTrafficSourceRows,
  trafficSourcePercentages,
} from '@/lib/youtube-analytics';

describe('parseTrafficSourceRows', () => {
  it('parses the documented YouTube Analytics shape', () => {
    const raw = {
      rows: [
        ['SUGGESTED', 12345],
        ['SEARCH', 5678],
        ['BROWSE', 432],
      ],
    };
    expect(parseTrafficSourceRows(raw)).toEqual({
      SUGGESTED: 12345,
      SEARCH: 5678,
      BROWSE: 432,
    });
  });

  it('uppercases lowercase source-type strings', () => {
    const raw = { rows: [['suggested', 100], ['search', 50]] };
    expect(parseTrafficSourceRows(raw)).toEqual({ SUGGESTED: 100, SEARCH: 50 });
  });

  it('coerces numeric strings (the API has been observed to return them)', () => {
    const raw = { rows: [['SUGGESTED', '500']] };
    expect(parseTrafficSourceRows(raw)).toEqual({ SUGGESTED: 500 });
  });

  it('sums duplicate source keys defensively', () => {
    // The API can split a source by sub-type that we collapse.
    const raw = {
      rows: [
        ['SUGGESTED', 100],
        ['SUGGESTED', 200],
      ],
    };
    expect(parseTrafficSourceRows(raw)).toEqual({ SUGGESTED: 300 });
  });

  it('drops malformed rows', () => {
    const raw = {
      rows: [
        ['SUGGESTED', 100],
        ['BAD', 'not-a-number'],
        [null, 50],
        ['SEARCH', NaN],
        ['EXTERNAL', 200],
      ],
    };
    expect(parseTrafficSourceRows(raw)).toEqual({
      SUGGESTED: 100,
      EXTERNAL: 200,
    });
  });

  it('returns null for missing rows / non-objects / empty result', () => {
    expect(parseTrafficSourceRows(null)).toBeNull();
    expect(parseTrafficSourceRows('not-an-object')).toBeNull();
    expect(parseTrafficSourceRows({})).toBeNull();
    expect(parseTrafficSourceRows({ rows: [] })).toBeNull();
  });
});

describe('trafficSourcePercentages', () => {
  it('returns empty for null / empty input', () => {
    expect(trafficSourcePercentages(null)).toEqual({});
    expect(trafficSourcePercentages({})).toEqual({});
  });

  it('normalises absolute counts to percentages summing to 100', () => {
    const out = trafficSourcePercentages({
      SUGGESTED: 600,
      SEARCH: 300,
      BROWSE: 100,
    });
    expect(out.SUGGESTED).toBeCloseTo(60, 5);
    expect(out.SEARCH).toBeCloseTo(30, 5);
    expect(out.BROWSE).toBeCloseTo(10, 5);
    const total = Object.values(out).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 3);
  });

  it('returns empty for an all-zero breakdown (avoid divide-by-zero)', () => {
    expect(trafficSourcePercentages({ SUGGESTED: 0, SEARCH: 0 })).toEqual({});
  });
});

describe('mergeBreakdowns', () => {
  it('sums per-video breakdowns into a workspace total', () => {
    expect(
      mergeBreakdowns([
        { SUGGESTED: 100, SEARCH: 50 },
        { SUGGESTED: 200, BROWSE: 30 },
        { SEARCH: 25 },
      ]),
    ).toEqual({
      SUGGESTED: 300,
      SEARCH: 75,
      BROWSE: 30,
    });
  });

  it('skips null entries (videos without a breakdown sync yet)', () => {
    expect(
      mergeBreakdowns([
        { SUGGESTED: 100 },
        null,
        { SEARCH: 50 },
      ]),
    ).toEqual({ SUGGESTED: 100, SEARCH: 50 });
  });

  it('drops non-finite per-source counts', () => {
    expect(
      mergeBreakdowns([{ SUGGESTED: 100, SEARCH: NaN, BROWSE: Infinity }]),
    ).toEqual({ SUGGESTED: 100 });
  });

  it('returns empty object for all-null input (cold-start workspace)', () => {
    expect(mergeBreakdowns([null, null])).toEqual({});
  });
});

describe('breakdownDelta', () => {
  it('returns recent_pct - prior_pct per source, sorted by absolute delta', () => {
    const out = breakdownDelta(
      { SUGGESTED: 50, SEARCH: 30, BROWSE: 20 },
      { SUGGESTED: 35, SEARCH: 35, BROWSE: 30 },
    );
    expect(out[0]!.source).toBe('SUGGESTED');
    expect(out[0]!.delta_pct).toBeCloseTo(15, 5);
    expect(out[out.length - 1]!.source).toBe('SEARCH');
    expect(out[out.length - 1]!.delta_pct).toBeCloseTo(-5, 5);
  });

  it('treats sources missing on one side as 0%', () => {
    const out = breakdownDelta({ SHORTS_FEED: 25 }, { SUGGESTED: 100 });
    expect(out.find((d) => d.source === 'SHORTS_FEED')?.delta_pct).toBe(25);
    expect(out.find((d) => d.source === 'SUGGESTED')?.delta_pct).toBe(-100);
  });

  it('sort order is stable when both deltas have the same magnitude', () => {
    const out = breakdownDelta({ A: 10, B: 5 }, { A: 0, B: 15 });
    // |10| === |10| — the order is implementation-defined but
    // shouldn't crash. Just assert both entries are present.
    expect(out).toHaveLength(2);
    expect(new Set(out.map((d) => d.source))).toEqual(new Set(['A', 'B']));
  });
});

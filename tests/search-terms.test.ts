import { describe, expect, it } from 'vitest';
import {
  parseSearchTermRows,
  scoreSeoOpportunities,
} from '@/lib/search-terms';

describe('parseSearchTermRows', () => {
  it('parses the documented Analytics API shape', () => {
    const raw = {
      rows: [
        ['ai agents tutorial', 1000, 50],   // CTR 5%
        ['claude api guide', 500, 30],       // CTR 6%
      ],
    };
    const out = parseSearchTermRows(raw);
    expect(out).toHaveLength(2);
    expect(out[0]!.search_term).toBe('ai agents tutorial');
    expect(out[0]!.impressions).toBe(1000);
    expect(out[0]!.views).toBe(50);
    expect(out[0]!.ctr_percentage).toBeCloseTo(5, 5);
    expect(out[1]!.ctr_percentage).toBeCloseTo(6, 5);
  });

  it('lowercases the term so trajectory grouping is stable', () => {
    const raw = { rows: [['AI Agents', 100, 5]] };
    expect(parseSearchTermRows(raw)[0]!.search_term).toBe('ai agents');
  });

  it('drops rows with zero impressions (noise)', () => {
    const raw = {
      rows: [
        ['real query', 100, 5],
        ['no-impression-noise', 0, 0],
      ],
    };
    const out = parseSearchTermRows(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.search_term).toBe('real query');
  });

  it('drops malformed rows', () => {
    const raw = {
      rows: [
        ['valid', 100, 5],
        [null, 100, 5],
        ['valid 2', 'not-a-number', 5],
        ['valid 3', 100, NaN],
      ],
    };
    const out = parseSearchTermRows(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.search_term).toBe('valid');
  });

  it('returns [] for missing / non-object input', () => {
    expect(parseSearchTermRows(null)).toEqual([]);
    expect(parseSearchTermRows('not-an-object')).toEqual([]);
    expect(parseSearchTermRows({})).toEqual([]);
    expect(parseSearchTermRows({ rows: [] })).toEqual([]);
  });

  it('caps the search_term at 240 chars (defence in depth)', () => {
    const long = 'a'.repeat(500);
    const out = parseSearchTermRows({ rows: [[long, 100, 5]] });
    expect(out[0]!.search_term.length).toBe(240);
  });
});

describe('scoreSeoOpportunities', () => {
  const baseline = 5;

  it('skips queries above baseline CTR (no opportunity)', () => {
    const out = scoreSeoOpportunities(
      [
        { search_term: 'great-clicker', impressions: 1000, views: 100, ctr_percentage: 10 },
      ],
      { baselineCtr: baseline },
    );
    expect(out).toEqual([]);
  });

  it('skips queries below the impression threshold', () => {
    const out = scoreSeoOpportunities(
      [
        { search_term: 'too-rare', impressions: 50, views: 0, ctr_percentage: 0 },
      ],
      { baselineCtr: baseline, minImpressions: 100 },
    );
    expect(out).toEqual([]);
  });

  it('ranks higher-impression underperformers above lower-impression ones', () => {
    const out = scoreSeoOpportunities(
      [
        { search_term: 'small-shortfall', impressions: 200, views: 8, ctr_percentage: 4 },   // 1pp below baseline, 200 imp
        { search_term: 'huge-volume',     impressions: 10000, views: 200, ctr_percentage: 2 }, // 3pp below baseline, 10K imp
        { search_term: 'medium',          impressions: 1500, views: 30, ctr_percentage: 2 },   // 3pp below baseline, 1.5K imp
      ],
      { baselineCtr: baseline },
    );
    expect(out[0]!.search_term).toBe('huge-volume');
    expect(out[out.length - 1]!.search_term).toBe('small-shortfall');
  });

  it('normalises opportunity_score to [0, 1]', () => {
    const out = scoreSeoOpportunities(
      [
        { search_term: 'a', impressions: 10000, views: 200, ctr_percentage: 2 },
        { search_term: 'b', impressions: 500, views: 15, ctr_percentage: 3 },
      ],
      { baselineCtr: 5 },
    );
    expect(out[0]!.opportunity_score).toBe(1);
    for (const o of out) {
      expect(o.opportunity_score).toBeGreaterThanOrEqual(0);
      expect(o.opportunity_score).toBeLessThanOrEqual(1);
    }
  });

  it('respects the limit parameter', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      search_term: `q${i}`,
      impressions: 1000 + i,
      views: 20,
      ctr_percentage: 2,
    }));
    const out = scoreSeoOpportunities(rows, { baselineCtr: 5, limit: 5 });
    expect(out).toHaveLength(5);
  });

  it('returns [] for empty input', () => {
    expect(scoreSeoOpportunities([])).toEqual([]);
  });
});

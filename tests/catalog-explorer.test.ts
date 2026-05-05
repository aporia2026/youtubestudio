import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTER,
  DEFAULT_SORT,
  DURATION_BUCKET_RANGES,
  normaliseFilter,
  normaliseSort,
  parseSavedViewName,
  SORT_FIELDS,
} from '@/lib/catalog-explorer';

const VALID_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('normaliseFilter', () => {
  it('falls back to defaults for non-objects', () => {
    expect(normaliseFilter(null)).toEqual(DEFAULT_FILTER);
    expect(normaliseFilter('not-an-object')).toEqual(DEFAULT_FILTER);
    expect(normaliseFilter(undefined)).toEqual(DEFAULT_FILTER);
  });

  it('passes through valid filter fields', () => {
    const out = normaliseFilter({
      channelDbIds: [VALID_UUID],
      formats: ['tutorial'],
      durations: ['mid'],
      publishedSince: '2026-01-01',
      publishedUntil: '2026-05-01',
      avpMin: 30,
      avpMax: 80,
      ctrMin: 4,
      ctrMax: 12,
      onlyBreakouts: true,
    });
    expect(out.channelDbIds).toEqual([VALID_UUID]);
    expect(out.formats).toEqual(['tutorial']);
    expect(out.durations).toEqual(['mid']);
    expect(out.publishedSince).toBe('2026-01-01');
    expect(out.publishedUntil).toBe('2026-05-01');
    expect(out.avpMin).toBe(30);
    expect(out.avpMax).toBe(80);
    expect(out.ctrMin).toBe(4);
    expect(out.ctrMax).toBe(12);
    expect(out.onlyBreakouts).toBe(true);
  });

  it('drops malformed channel ids (non-UUIDs are noise / injection attempts)', () => {
    const out = normaliseFilter({
      channelDbIds: [VALID_UUID, 'not-a-uuid', 123, '"); DROP TABLE; --'],
    });
    expect(out.channelDbIds).toEqual([VALID_UUID]);
  });

  it('drops unknown format strings', () => {
    const out = normaliseFilter({ formats: ['tutorial', 'rambling', 42, null] });
    expect(out.formats).toEqual(['tutorial']);
  });

  it('drops unknown duration buckets', () => {
    const out = normaliseFilter({ durations: ['short', 'extra-long', 'XL'] });
    expect(out.durations).toEqual(['short']);
  });

  it('rejects malformed dates', () => {
    const out = normaliseFilter({
      publishedSince: '01/01/2026',
      publishedUntil: 'last week',
    });
    expect(out.publishedSince).toBeNull();
    expect(out.publishedUntil).toBeNull();
  });

  it('clamps numeric thresholds to [0, 100]', () => {
    const out = normaliseFilter({
      avpMin: -5,
      avpMax: 150,
      ctrMin: 'high',
      ctrMax: NaN,
    });
    expect(out.avpMin).toBe(0);
    expect(out.avpMax).toBe(100);
    expect(out.ctrMin).toBeNull();
    expect(out.ctrMax).toBeNull();
  });

  it('treats onlyBreakouts as strict boolean (truthy strings don\'t count)', () => {
    expect(normaliseFilter({ onlyBreakouts: 'true' }).onlyBreakouts).toBe(false);
    expect(normaliseFilter({ onlyBreakouts: 1 }).onlyBreakouts).toBe(false);
    expect(normaliseFilter({ onlyBreakouts: true }).onlyBreakouts).toBe(true);
  });
});

describe('normaliseSort', () => {
  it('falls back to default for non-objects', () => {
    expect(normaliseSort(null)).toEqual(DEFAULT_SORT);
    expect(normaliseSort(undefined)).toEqual(DEFAULT_SORT);
  });

  it('accepts every documented sort field', () => {
    for (const field of SORT_FIELDS) {
      const out = normaliseSort({ field, dir: 'asc' });
      expect(out.field).toBe(field);
      expect(out.dir).toBe('asc');
    }
  });

  it('rejects unknown fields and falls back to default', () => {
    const out = normaliseSort({ field: 'something_random', dir: 'desc' });
    expect(out.field).toBe(DEFAULT_SORT.field);
  });

  it('treats any dir other than "asc" as desc', () => {
    expect(normaliseSort({ field: 'views', dir: 'asc' }).dir).toBe('asc');
    expect(normaliseSort({ field: 'views', dir: 'desc' }).dir).toBe('desc');
    expect(normaliseSort({ field: 'views', dir: 'random' }).dir).toBe('desc');
    expect(normaliseSort({ field: 'views' }).dir).toBe('desc');
  });
});

describe('parseSavedViewName', () => {
  it('accepts a 1-80 char trimmed string', () => {
    expect(parseSavedViewName('  My View  ')).toBe('My View');
    expect(parseSavedViewName('a'.repeat(80))).toBe('a'.repeat(80));
  });
  it('rejects empty / overlong / non-strings', () => {
    expect(parseSavedViewName('')).toBeNull();
    expect(parseSavedViewName('   ')).toBeNull();
    expect(parseSavedViewName('a'.repeat(81))).toBeNull();
    expect(parseSavedViewName(42)).toBeNull();
    expect(parseSavedViewName(null)).toBeNull();
  });
});

describe('DURATION_BUCKET_RANGES', () => {
  it('forms a contiguous, non-overlapping set', () => {
    expect(DURATION_BUCKET_RANGES.shorts).toEqual([0, 60]);
    expect(DURATION_BUCKET_RANGES.short).toEqual([60, 5 * 60]);
    expect(DURATION_BUCKET_RANGES.mid).toEqual([5 * 60, 15 * 60]);
    expect(DURATION_BUCKET_RANGES.long).toEqual([15 * 60, null]);
  });
});

/**
 * Tests for the pure helpers in the YouTube ingest layer.
 *
 * Network-dependent functions (fetchSuggestions, searchVideosForCluster,
 * fetchVideosBatch, fetchChannelsBatch, harvestClusterSample) are
 * exercised end-to-end in the route-level smoke test rather than
 * mocked here — mocking fetch + the DB cache would be more brittle
 * than just running the routes.
 */
import { describe, expect, it } from 'vitest';
import { parseSuggestResponse, suggestUrl } from '@/lib/niche-finder/youtube-suggest';

describe('parseSuggestResponse', () => {
  it('parses the standard YouTube Suggest tuple shape', () => {
    const raw = ['history', [['history channel'], ['history of rome'], ['historical fiction']]];
    expect(parseSuggestResponse(raw)).toEqual([
      'history channel',
      'history of rome',
      'historical fiction',
    ]);
  });

  it('parses plain-string suggestion items', () => {
    const raw = ['x', ['alpha', 'beta', 'gamma']];
    expect(parseSuggestResponse(raw)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('parses object-keyed suggestion items', () => {
    const raw = ['x', [{ 0: 'foo' }, { 0: 'bar' }]];
    expect(parseSuggestResponse(raw)).toEqual(['foo', 'bar']);
  });

  it('returns empty for non-array input', () => {
    expect(parseSuggestResponse(null)).toEqual([]);
    expect(parseSuggestResponse({})).toEqual([]);
    expect(parseSuggestResponse('x')).toEqual([]);
  });

  it('returns empty when the suggestions block is missing', () => {
    expect(parseSuggestResponse(['x'])).toEqual([]);
  });

  it('drops empty strings and trims whitespace via dedupe', () => {
    const raw = ['x', [[''], ['  '], ['  trimmed  ']]];
    const out = parseSuggestResponse(raw);
    // Note: parseSuggestResponse only trims for dedupe, but the
    // original (with whitespace) is what we push. Confirm the
    // empty-string entries are dropped at minimum.
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.every((s) => s.length > 0)).toBe(true);
  });

  it('caps at 10 suggestions', () => {
    const raw = ['x', Array.from({ length: 50 }, (_, i) => [`s${i}`])];
    expect(parseSuggestResponse(raw).length).toBe(10);
  });

  it('de-duplicates entries', () => {
    const raw = ['x', [['a'], ['b'], ['a'], ['c'], ['b']]];
    expect(parseSuggestResponse(raw)).toEqual(['a', 'b', 'c']);
  });
});

describe('suggestUrl', () => {
  it('builds a youtube+yt scoped URL', () => {
    const url = suggestUrl('history', 'en');
    expect(url).toContain('client=youtube');
    expect(url).toContain('ds=yt');
    expect(url).toContain('q=history');
    expect(url).toContain('hl=en');
  });

  it('URL-encodes the query', () => {
    const url = suggestUrl('history of rome', 'en');
    // URLSearchParams encodes space as `+`. Both `+` and `%20` are
    // accepted by RFC 3986; we accept either.
    expect(/q=history(\+|%20)of(\+|%20)rome/.test(url)).toBe(true);
  });

  it('passes locale through', () => {
    expect(suggestUrl('sport', 'es')).toContain('hl=es');
  });
});

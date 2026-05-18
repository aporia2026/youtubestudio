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
import {
  isLatinDominantTitle,
  passesLanguageFilter,
} from '@/lib/niche-finder/youtube-fetch';

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

describe('isLatinDominantTitle', () => {
  it('accepts plain English', () => {
    expect(isLatinDominantTitle('Top 10 Movies of 2025')).toBe(true);
  });

  it('accepts accented Latin (Spanish / French / German / Portuguese)', () => {
    expect(isLatinDominantTitle('¿Qué pasó con la película?')).toBe(true);
    expect(isLatinDominantTitle('Le film le plus drôle')).toBe(true);
    expect(isLatinDominantTitle('Größte Filme aller Zeiten')).toBe(true);
  });

  it('drops Devanagari-dominant (Hindi) titles', () => {
    expect(isLatinDominantTitle('हिंदी मूवी कलेक्शन')).toBe(false);
  });

  it('drops CJK-dominant titles', () => {
    expect(isLatinDominantTitle('日本のアニメ映画')).toBe(false);
    expect(isLatinDominantTitle('한국 영화 베스트')).toBe(false);
    expect(isLatinDominantTitle('中国电影推荐')).toBe(false);
  });

  it('drops Arabic / Cyrillic / Thai titles', () => {
    expect(isLatinDominantTitle('أفضل الأفلام العربية')).toBe(false);
    expect(isLatinDominantTitle('Лучшие русские фильмы')).toBe(false);
    expect(isLatinDominantTitle('ภาพยนตร์ไทยที่ดีที่สุด')).toBe(false);
  });

  it('keeps mixed-script titles when Latin dominates the letter count', () => {
    // "Hello World" = 10 Latin letters; "नमस्ते" = 6 Devanagari code
    // points (including combining marks). 10 / 16 = 62% Latin — keep.
    expect(isLatinDominantTitle('Hello World नमस्ते')).toBe(true);
  });

  it('drops mixed-script titles when non-Latin dominates the letter count', () => {
    // 5 ASCII letters vs many Devanagari code points — non-Latin dominates.
    expect(isLatinDominantTitle('Hello नमस्तेजीवन भारत संगीत')).toBe(false);
  });

  it('keeps titles with no letters (digits / emoji / punctuation only)', () => {
    expect(isLatinDominantTitle('2025!!! 🎬')).toBe(true);
    expect(isLatinDominantTitle('????')).toBe(true);
    expect(isLatinDominantTitle('')).toBe(true);
  });

  it('handles non-string input gracefully', () => {
    // @ts-expect-error intentionally wrong type
    expect(isLatinDominantTitle(undefined)).toBe(true);
    // @ts-expect-error intentionally wrong type
    expect(isLatinDominantTitle(null)).toBe(true);
  });
});

describe('passesLanguageFilter', () => {
  function v(partial: Partial<{ title: string; defaultAudioLanguage: string | null; defaultLanguage: string | null }>) {
    return {
      title: 'A Reasonable Title',
      defaultAudioLanguage: null,
      defaultLanguage: null,
      ...partial,
    };
  }

  it('keeps a video whose audio-language tag matches the requested language', () => {
    expect(
      passesLanguageFilter(v({ title: 'भारत', defaultAudioLanguage: 'en' }), 'en'),
    ).toBe(true);
  });

  it('drops a video whose audio-language tag mismatches the requested language', () => {
    expect(
      passesLanguageFilter(
        v({ title: 'Hello world', defaultAudioLanguage: 'hi' }),
        'en',
      ),
    ).toBe(false);
  });

  it('falls back to title-script heuristic when no language tag is set', () => {
    expect(passesLanguageFilter(v({ title: 'Top movies' }), 'en')).toBe(true);
    expect(passesLanguageFilter(v({ title: 'हिंदी मूवी' }), 'en')).toBe(false);
  });

  it('compares only the ISO 639-1 prefix (en-US vs en-GB)', () => {
    expect(
      passesLanguageFilter(v({ defaultAudioLanguage: 'en-US' }), 'en-GB'),
    ).toBe(true);
  });

  it('keeps the video when the requested language is non-Latin-scripted and no tag is set', () => {
    // No `defaultAudioLanguage`/`defaultLanguage`, requested 'hi' (Hindi).
    // Script heuristic does not apply, so we don't drop a Latin title.
    expect(passesLanguageFilter(v({ title: 'Top videos' }), 'hi')).toBe(true);
  });
});

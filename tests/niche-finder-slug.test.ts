/**
 * Tests for the niche-slug + cache-key helpers. Both are pure
 * functions and load-bearing for cache correctness (two operators
 * typing the same niche in different casings must collide on the
 * same cache row + same niche_reports row).
 */
import { describe, expect, it } from 'vitest';
import { slugifyNiche, normalizeNicheName } from '@/lib/niche-finder/slug';
import { cacheKey } from '@/lib/niche-finder/db';

describe('slugifyNiche', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyNiche('Personal Finance')).toBe('personal-finance');
  });

  it('collapses any run of non-alphanumerics into a single hyphen', () => {
    expect(slugifyNiche('Sports / Stats — Deep Dive')).toBe('sports-stats-deep-dive');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugifyNiche('  ---history---  ')).toBe('history');
  });

  it('strips diacritics', () => {
    expect(slugifyNiche('café noir')).toBe('cafe-noir');
  });

  it('returns the same slug for the same canonical input regardless of casing or punctuation', () => {
    expect(slugifyNiche('History')).toBe(slugifyNiche('history'));
    expect(slugifyNiche('History!')).toBe(slugifyNiche('history'));
    expect(slugifyNiche('  HISTORY  ')).toBe(slugifyNiche('history'));
  });

  it('returns untitled-niche for empty-equivalent input', () => {
    expect(slugifyNiche('')).toBe('untitled-niche');
    expect(slugifyNiche('   ')).toBe('untitled-niche');
    expect(slugifyNiche('!!!')).toBe('untitled-niche');
    // @ts-expect-error intentionally wrong type
    expect(slugifyNiche(null)).toBe('untitled-niche');
  });

  it('caps length at 80 characters and never ends in a hyphen', () => {
    const huge = 'a'.repeat(200);
    const result = slugifyNiche(huge);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith('-')).toBe(false);
  });

  it('handles unicode whitespace', () => {
    expect(slugifyNiche('history documentary')).toBe('history-documentary');
  });
});

describe('normalizeNicheName', () => {
  it('preserves casing and trims', () => {
    expect(normalizeNicheName('  Personal Finance  ')).toBe('Personal Finance');
  });

  it('collapses runs of whitespace', () => {
    expect(normalizeNicheName('Sports     Stats')).toBe('Sports Stats');
  });

  it('returns Untitled niche for empty input', () => {
    expect(normalizeNicheName('')).toBe('Untitled niche');
    expect(normalizeNicheName('   ')).toBe('Untitled niche');
  });

  it('caps display length at 120 characters', () => {
    const huge = 'A'.repeat(300);
    expect(normalizeNicheName(huge).length).toBeLessThanOrEqual(120);
  });
});

describe('cacheKey', () => {
  it('returns the same key for the same request', () => {
    const k1 = cacheKey({ method: 'GET', url: 'https://example.com/api?x=1' });
    const k2 = cacheKey({ method: 'GET', url: 'https://example.com/api?x=1' });
    expect(k1).toBe(k2);
  });

  it('is case-insensitive on the method', () => {
    const k1 = cacheKey({ method: 'GET', url: 'https://example.com/' });
    const k2 = cacheKey({ method: 'get', url: 'https://example.com/' });
    expect(k1).toBe(k2);
  });

  it('differs across URLs', () => {
    const k1 = cacheKey({ method: 'GET', url: 'https://example.com/a' });
    const k2 = cacheKey({ method: 'GET', url: 'https://example.com/b' });
    expect(k1).not.toBe(k2);
  });

  it('differs when a body is supplied', () => {
    const k1 = cacheKey({ method: 'POST', url: 'https://example.com/' });
    const k2 = cacheKey({ method: 'POST', url: 'https://example.com/', body: '{"x":1}' });
    expect(k1).not.toBe(k2);
  });

  it('is 64 hex chars (sha256)', () => {
    const k = cacheKey({ method: 'GET', url: 'https://example.com/' });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

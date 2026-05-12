/**
 * Unit tests for the discovery layer (modes A, B, C).
 *
 * Covers:
 *   - canonicaliseInterests collapses order + casing so the cache
 *     key is stable.
 *   - hashDiscoveryInput is deterministic + 64-hex.
 *   - parseCandidatesOutput tolerates the same input shapes the AI
 *     produces and rejects malformed output cleanly.
 *   - The category taxonomy is structurally valid.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicaliseInterests,
  hashDiscoveryInput,
} from '@/lib/niche-finder/discoveries-db';
import { parseCandidatesOutput } from '@/lib/niche-finder/discover-from-interests';
import { NICHE_CATEGORIES, getCategory } from '@/lib/niche-finder/categories';

describe('canonicaliseInterests', () => {
  it('collapses different orderings to the same canonical form', () => {
    expect(canonicaliseInterests(['history', 'tech', 'finance'])).toBe(
      canonicaliseInterests(['tech', 'finance', 'history']),
    );
  });

  it('lowercases and trims', () => {
    expect(canonicaliseInterests(['  History  ', 'TECH'])).toBe('history|tech');
  });

  it('drops empty strings', () => {
    expect(canonicaliseInterests(['history', '', '   ', 'tech'])).toBe('history|tech');
  });

  it('returns empty string for all-empty input', () => {
    expect(canonicaliseInterests([])).toBe('');
    expect(canonicaliseInterests(['', '   '])).toBe('');
  });
});

describe('hashDiscoveryInput', () => {
  it('is deterministic', () => {
    expect(hashDiscoveryInput('foo')).toBe(hashDiscoveryInput('foo'));
  });

  it('differs across inputs', () => {
    expect(hashDiscoveryInput('foo')).not.toBe(hashDiscoveryInput('bar'));
  });

  it('returns a 64-char hex string (sha256)', () => {
    expect(hashDiscoveryInput('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('combines with canonicaliseInterests for stable interest hashes', () => {
    const a = hashDiscoveryInput(canonicaliseInterests(['history', 'tech']));
    const b = hashDiscoveryInput(canonicaliseInterests(['tech', 'history']));
    expect(a).toBe(b);
  });
});

describe('parseCandidatesOutput', () => {
  it('parses a well-formed AI response with 8 niches', () => {
    const raw = JSON.stringify({
      niches: Array.from({ length: 8 }, (_, i) => ({
        name: `niche ${i}`,
        rationale: `because ${i}`,
      })),
    });
    const parsed = parseCandidatesOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!).toHaveLength(8);
    expect(parsed![0].name).toBe('niche 0');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify({ niches: [{ name: 'x', rationale: 'y' }] }) + '\n```';
    expect(parseCandidatesOutput(raw)).not.toBeNull();
  });

  it('returns null for non-JSON', () => {
    expect(parseCandidatesOutput('not json at all')).toBeNull();
  });

  it('returns null when niches key is missing or wrong type', () => {
    expect(parseCandidatesOutput('{}')).toBeNull();
    expect(parseCandidatesOutput('{"niches":"x"}')).toBeNull();
  });

  it('returns null when every candidate is invalid', () => {
    const raw = JSON.stringify({
      niches: [{ name: '' }, { name: '   ' }, { rationale: 'no name' }],
    });
    expect(parseCandidatesOutput(raw)).toBeNull();
  });

  it('de-duplicates candidates with the same name (case-insensitive)', () => {
    const raw = JSON.stringify({
      niches: [
        { name: 'History documentary', rationale: 'a' },
        { name: 'history documentary', rationale: 'b' },
        { name: 'tech reviews', rationale: 'c' },
      ],
    });
    const parsed = parseCandidatesOutput(raw)!;
    expect(parsed).toHaveLength(2);
  });

  it('caps at 8 candidates', () => {
    const raw = JSON.stringify({
      niches: Array.from({ length: 50 }, (_, i) => ({ name: `n${i}`, rationale: 'r' })),
    });
    expect(parseCandidatesOutput(raw)!.length).toBeLessThanOrEqual(8);
  });

  it('drops niches whose name is too long', () => {
    const raw = JSON.stringify({
      niches: [
        { name: 'a'.repeat(200), rationale: 'x' },
        { name: 'short niche', rationale: 'y' },
      ],
    });
    const parsed = parseCandidatesOutput(raw)!;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('short niche');
  });

  it('truncates long rationales to 200 chars', () => {
    const raw = JSON.stringify({
      niches: [{ name: 'a niche', rationale: 'x'.repeat(500) }],
    });
    expect(parseCandidatesOutput(raw)![0].rationale.length).toBeLessThanOrEqual(200);
  });
});

describe('niche category taxonomy', () => {
  it('every category has at least 4 sub-niches', () => {
    for (const c of NICHE_CATEGORIES) {
      expect(c.subNiches.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('every category has a unique slug', () => {
    const slugs = new Set(NICHE_CATEGORIES.map((c) => c.slug));
    expect(slugs.size).toBe(NICHE_CATEGORIES.length);
  });

  it('every sub-niche is at least 2 words (specific, not generic)', () => {
    for (const c of NICHE_CATEGORIES) {
      for (const sub of c.subNiches) {
        expect(sub.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('getCategory returns null for unknown slugs', () => {
    expect(getCategory('does-not-exist')).toBeUndefined();
  });

  it('getCategory returns a known category', () => {
    const c = getCategory('finance');
    expect(c).toBeDefined();
    expect(c!.name).toBe('Finance');
  });

  it('every category has a description', () => {
    for (const c of NICHE_CATEGORIES) {
      expect(c.description.trim().length).toBeGreaterThan(10);
    }
  });
});

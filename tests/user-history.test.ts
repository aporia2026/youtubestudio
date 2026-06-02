/**
 * Pure-logic tests for the server-side history library exports.
 *
 * The DB-touching helpers (listUserHistory, saveUserHistory, etc.)
 * are exercised indirectly via the route tests in
 * `tests/history-routes.test.ts` with a mocked `@vercel/postgres`.
 */
import { describe, expect, it } from 'vitest';
import {
  HISTORY_KINDS,
  KIND_CAPS,
  MAX_PAYLOAD_BYTES,
  isHistoryKind,
} from '@/lib/user-history';
import { isUuid } from '@/lib/user-history-types';

describe('HISTORY_KINDS', () => {
  it('contains exactly the registered panel kinds', () => {
    expect([...HISTORY_KINDS].sort()).toEqual(
      [
        'ideas',
        'production_doc',
        'qa',
        'script',
        'seo',
        'shorts_ideas',
        'thumbnail',
        'voiceover',
      ].sort(),
    );
  });

  it('every kind is a valid SQL identifier (no quoting needed)', () => {
    for (const k of HISTORY_KINDS) {
      expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('kinds are unique', () => {
    expect(new Set(HISTORY_KINDS).size).toBe(HISTORY_KINDS.length);
  });
});

describe('KIND_CAPS', () => {
  it('has a positive cap for every kind', () => {
    for (const k of HISTORY_KINDS) {
      expect(KIND_CAPS[k], `${k} cap`).toBeGreaterThan(0);
      expect(KIND_CAPS[k], `${k} cap`).toBeLessThanOrEqual(500);
    }
  });

  it('matches the legacy localStorage MAX_*_ENTRIES values', () => {
    // These mirror MAX_SCRIPT_ENTRIES / MAX_IDEAS_ENTRIES / etc. from
    // the pre-migration src/lib/history.ts. Bumping a value here is
    // fine, but it's a deliberate UX change — keep this assertion in
    // sync with the docs.
    expect(KIND_CAPS.script).toBe(50);
    expect(KIND_CAPS.ideas).toBe(100);
    expect(KIND_CAPS.voiceover).toBe(100);
    expect(KIND_CAPS.seo).toBe(50);
    expect(KIND_CAPS.thumbnail).toBe(50);
    expect(KIND_CAPS.qa).toBe(50);
    expect(KIND_CAPS.production_doc).toBe(30);
  });

  it('has no extra keys beyond HISTORY_KINDS', () => {
    expect(Object.keys(KIND_CAPS).sort()).toEqual([...HISTORY_KINDS].sort());
  });
});

describe('isHistoryKind', () => {
  it('accepts every declared kind', () => {
    for (const k of HISTORY_KINDS) {
      expect(isHistoryKind(k)).toBe(true);
    }
  });

  it.each([
    ['unknown_kind', false],
    ['', false],
    ['SCRIPT', false], // case-sensitive
    ['script ', false], // trailing space
    [' script', false], // leading space
    ['scripts', false], // plural
  ] as const)('rejects %j', (value, expected) => {
    expect(isHistoryKind(value)).toBe(expected);
  });

  it('rejects non-string values', () => {
    expect(isHistoryKind(undefined)).toBe(false);
    expect(isHistoryKind(null)).toBe(false);
    expect(isHistoryKind(42)).toBe(false);
    expect(isHistoryKind({})).toBe(false);
    expect(isHistoryKind(['script'])).toBe(false);
    expect(isHistoryKind(true)).toBe(false);
  });
});

describe('MAX_PAYLOAD_BYTES', () => {
  it('is large enough for a capped script + metadata', () => {
    // The client truncates scripts to 15K chars before saving. With
    // surrounding metadata (refs, constraints, etc.) the payload
    // ceiling needs comfortable headroom — a script-only entry should
    // fit ~10× over.
    expect(MAX_PAYLOAD_BYTES).toBeGreaterThanOrEqual(150_000);
  });

  it('is small enough to refuse a 10MB blob', () => {
    expect(MAX_PAYLOAD_BYTES).toBeLessThan(10 * 1024 * 1024);
  });
});

describe('isUuid', () => {
  it.each([
    '00000000-0000-0000-0000-000000000000', // nil UUID
    '12345678-1234-1234-8234-1234567890ab', // v1
    '12345678-1234-4234-8234-1234567890ab', // v4 (most common)
    '12345678-1234-5234-9234-1234567890ab', // v5
    'AAAAAAAA-BBBB-4CCC-9DDD-EEEEEEEEEEEE', // uppercase
  ] as const)('accepts %s', (id) => {
    expect(isUuid(id)).toBe(true);
  });

  it.each([
    '',
    'not-a-uuid',
    '12345678-1234-1234-1234-123456789012', // wrong version digit (1 in 13th, but variant slot has 1 → invalid)
    '12345678-1234-4234-c234-1234567890ab', // wrong variant digit
    '12345678-1234-4234-8234-1234567890a', // too short
    '12345678-1234-4234-8234-1234567890abc', // too long
    '12345678_1234_4234_8234_1234567890ab', // wrong separators
    '1740000000-abc-random-suffix', // legacy localStorage `${Date.now()}-${random}` shape
  ] as const)('rejects %s', (id) => {
    expect(isUuid(id)).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid({})).toBe(false);
  });
});

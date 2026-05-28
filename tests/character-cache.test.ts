import { describe, expect, it } from 'vitest';
import {
  buildCharacterContinuationEditPrompt,
  getCachedCharacterBase,
  writeCharacterToCache,
  type CharacterCache,
} from '@/lib/character-cache';

describe('buildCharacterContinuationEditPrompt', () => {
  it('wraps a raw scene prompt in the identity-preservation Edit instruction', () => {
    const out = buildCharacterContinuationEditPrompt(
      'George stands at the doorway of a burning house, smoke rising behind him.',
    );
    // Spot-check the load-bearing phrases — these are the guard-rails
    // the smoke test established.
    expect(out).toContain('SAME character');
    expect(out).toContain('EXACTLY identical');
    expect(out).toContain('face, hair, body proportions, clothing');
    expect(out).toContain('George stands at the doorway');
    expect(out).toContain('hand-drawn doodle style');
  });

  it('trims surrounding whitespace from the scene prompt', () => {
    const out = buildCharacterContinuationEditPrompt('   George in a chair   ');
    expect(out).toContain('this new scene: George in a chair.');
    expect(out).not.toContain('   George');
  });
});

describe('getCachedCharacterBase', () => {
  const cache: CharacterCache = {
    george: { base_url: 'https://r2.example.com/george.png', first_seen_row_index: 0 },
    'louis-as-adult': { base_url: 'https://r2.example.com/louis-adult.png', first_seen_row_index: 13 },
  };

  it('returns the base url for a hit', () => {
    expect(getCachedCharacterBase(cache, 'george')).toBe('https://r2.example.com/george.png');
    expect(getCachedCharacterBase(cache, 'louis-as-adult')).toBe('https://r2.example.com/louis-adult.png');
  });

  it('returns undefined on a miss', () => {
    expect(getCachedCharacterBase(cache, 'jennie')).toBeUndefined();
  });

  it('returns undefined for empty / whitespace character_id', () => {
    expect(getCachedCharacterBase(cache, '')).toBeUndefined();
    expect(getCachedCharacterBase(cache, '   ')).toBeUndefined();
  });

  it('returns undefined when the cache itself is null or undefined', () => {
    expect(getCachedCharacterBase(undefined, 'george')).toBeUndefined();
    expect(getCachedCharacterBase(null, 'george')).toBeUndefined();
  });
});

describe('writeCharacterToCache', () => {
  it('inserts a new entry into an empty cache', () => {
    const next = writeCharacterToCache(undefined, 'george', 'https://r2/g.png', 2);
    expect(next).toEqual({
      george: { base_url: 'https://r2/g.png', first_seen_row_index: 2 },
    });
  });

  it('preserves existing entries when adding a new character', () => {
    const before: CharacterCache = {
      george: { base_url: 'https://r2/g.png', first_seen_row_index: 0 },
    };
    const after = writeCharacterToCache(before, 'jennie', 'https://r2/j.png', 4);
    expect(after).toEqual({
      george: { base_url: 'https://r2/g.png', first_seen_row_index: 0 },
      jennie: { base_url: 'https://r2/j.png', first_seen_row_index: 4 },
    });
  });

  it('first-occurrence wins — does NOT overwrite an existing entry', () => {
    // This is load-bearing. Overwriting on later rows would let the
    // canonical character identity drift mid-doc, which is the exact
    // failure mode the cache exists to prevent.
    const before: CharacterCache = {
      george: { base_url: 'https://r2/canonical.png', first_seen_row_index: 0 },
    };
    const after = writeCharacterToCache(before, 'george', 'https://r2/different.png', 5);
    expect(after.george.base_url).toBe('https://r2/canonical.png');
    expect(after.george.first_seen_row_index).toBe(0);
  });

  it('does NOT mutate the input cache', () => {
    const before: CharacterCache = {
      george: { base_url: 'https://r2/g.png', first_seen_row_index: 0 },
    };
    const snapshot = JSON.parse(JSON.stringify(before));
    writeCharacterToCache(before, 'jennie', 'https://r2/j.png', 4);
    expect(before).toEqual(snapshot);
  });

  it('returns the cache unchanged when character_id is empty or whitespace', () => {
    const before: CharacterCache = {
      george: { base_url: 'https://r2/g.png', first_seen_row_index: 0 },
    };
    expect(writeCharacterToCache(before, '', 'https://r2/x.png', 1)).toEqual(before);
    expect(writeCharacterToCache(before, '   ', 'https://r2/x.png', 1)).toEqual(before);
  });

  it('returns the cache unchanged when baseUrl is empty', () => {
    const before: CharacterCache = {};
    expect(writeCharacterToCache(before, 'george', '', 1)).toEqual({});
    expect(writeCharacterToCache(before, 'george', '   ', 1)).toEqual({});
  });
});

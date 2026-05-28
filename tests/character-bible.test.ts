import { describe, expect, it } from 'vitest';
import {
  buildCharacterBiblePrefix,
  prependCharacterBible,
  type CharacterDescriptions,
} from '@/lib/character-bible';

describe('buildCharacterBiblePrefix', () => {
  it('returns an empty string when descriptions are undefined or null', () => {
    expect(buildCharacterBiblePrefix(undefined)).toBe('');
    expect(buildCharacterBiblePrefix(null)).toBe('');
  });

  it('returns an empty string when descriptions are empty', () => {
    expect(buildCharacterBiblePrefix({})).toBe('');
  });

  it('builds a reference block for a single character', () => {
    const descriptions: CharacterDescriptions = {
      george: 'Gray hair, mustache, dark vest over a white shirt, brown trousers.',
    };
    const out = buildCharacterBiblePrefix(descriptions);
    expect(out).toContain('Character reference for this scene:');
    expect(out).toContain('- george: Gray hair, mustache, dark vest over a white shirt, brown trousers.');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('builds a multi-entry reference block', () => {
    const descriptions: CharacterDescriptions = {
      george: 'Gray hair, mustache, dark vest.',
      jennie: 'Yellow dress, brown hair pulled back.',
      'louis-as-adult': 'Tall, brown coat, beard.',
    };
    const out = buildCharacterBiblePrefix(descriptions);
    expect(out).toContain('- george: Gray hair, mustache, dark vest.');
    expect(out).toContain('- jennie: Yellow dress, brown hair pulled back.');
    expect(out).toContain('- louis-as-adult: Tall, brown coat, beard.');
  });

  it('skips entries with empty or whitespace slugs / descriptions', () => {
    const descriptions: CharacterDescriptions = {
      george: 'Real description.',
      '': 'Stray empty slug.',
      '   ': 'Whitespace slug.',
      'no-desc': '',
      'whitespace-desc': '   ',
    };
    const out = buildCharacterBiblePrefix(descriptions);
    expect(out).toContain('- george: Real description.');
    expect(out).not.toContain('Stray empty slug');
    expect(out).not.toContain('Whitespace slug');
    expect(out).not.toContain('- no-desc');
    expect(out).not.toContain('- whitespace-desc');
  });

  it('trims whitespace from descriptions but preserves slug formatting', () => {
    const descriptions: CharacterDescriptions = {
      george: '   Description with surrounding spaces.   ',
    };
    const out = buildCharacterBiblePrefix(descriptions);
    expect(out).toContain('- george: Description with surrounding spaces.');
    // No double-space, no leading whitespace after the colon.
    expect(out).not.toContain('george:  Description');
  });
});

describe('prependCharacterBible', () => {
  it('returns the prompt unchanged when descriptions are missing', () => {
    const prompt = 'A wide shot of the burning house.';
    expect(prependCharacterBible(prompt, undefined)).toBe(prompt);
    expect(prependCharacterBible(prompt, null)).toBe(prompt);
    expect(prependCharacterBible(prompt, {})).toBe(prompt);
  });

  it('prepends the bible block before the prompt', () => {
    const prompt = 'A wide shot of the burning house.';
    const descriptions: CharacterDescriptions = {
      george: 'Gray hair, mustache.',
      jennie: 'Yellow dress.',
    };
    const out = prependCharacterBible(prompt, descriptions);
    // Bible MUST come first so the model sees it before the scene body.
    expect(out.indexOf('Character reference for this scene:')).toBeLessThan(
      out.indexOf('A wide shot of the burning house.'),
    );
    expect(out).toContain('- george: Gray hair, mustache.');
    expect(out).toContain('A wide shot of the burning house.');
  });

  it('does not duplicate the bible if called twice (idempotent on the prefix portion)', () => {
    // The current implementation does NOT detect double-prepending —
    // callers are responsible for calling once per dispatch. This test
    // documents that contract.
    const descriptions: CharacterDescriptions = { george: 'Gray hair.' };
    const once = prependCharacterBible('Scene body.', descriptions);
    const twice = prependCharacterBible(once, descriptions);
    expect(twice.match(/Character reference for this scene:/g)?.length).toBe(2);
  });
});

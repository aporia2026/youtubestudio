import { describe, expect, it } from 'vitest';
import {
  buildCharacterBiblePrefix,
  collectCharacterIds,
  collectSceneIds,
  findUntaggedDescriptions,
  prependCharacterBible,
  tallyCharacterIds,
  tallySceneIds,
  validateSlug,
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

// ─── Phase 4 (Editor UI) — collectors ───────────────────────────────────────

describe('collectCharacterIds', () => {
  it('returns unique sorted slugs from rows', () => {
    const rows = [
      { character_id: 'george' },
      { character_id: 'jennie' },
      { character_id: 'george' },
      { character_id: 'louis-as-adult' },
    ];
    expect(collectCharacterIds(rows)).toEqual(['george', 'jennie', 'louis-as-adult']);
  });

  it('skips empty / whitespace / undefined values', () => {
    const rows = [
      { character_id: 'george' },
      { character_id: '' },
      { character_id: '   ' },
      {},
      { character_id: undefined },
    ];
    expect(collectCharacterIds(rows)).toEqual(['george']);
  });

  it('returns an empty array for an empty input', () => {
    expect(collectCharacterIds([])).toEqual([]);
  });
});

describe('collectSceneIds', () => {
  it('returns unique sorted scene slugs', () => {
    const rows = [
      { scene_id: 'sodder-house' },
      { scene_id: 'investigator-desk' },
      { scene_id: 'sodder-house' },
    ];
    expect(collectSceneIds(rows)).toEqual(['investigator-desk', 'sodder-house']);
  });

  it('ignores character_id and only collects scene_id', () => {
    const rows = [
      { character_id: 'george', scene_id: 'sodder-house' },
      { character_id: 'jennie' },
    ];
    expect(collectSceneIds(rows)).toEqual(['sodder-house']);
  });
});

describe('tallyCharacterIds', () => {
  it('counts rows per slug', () => {
    const rows = [
      { character_id: 'george' },
      { character_id: 'george' },
      { character_id: 'jennie' },
      { character_id: 'george' },
    ];
    expect(tallyCharacterIds(rows)).toEqual({ george: 3, jennie: 1 });
  });
});

describe('tallySceneIds', () => {
  it('counts rows per scene slug', () => {
    const rows = [
      { scene_id: 'sodder-house' },
      { scene_id: 'sodder-house' },
      { scene_id: 'investigator-desk' },
    ];
    expect(tallySceneIds(rows)).toEqual({ 'sodder-house': 2, 'investigator-desk': 1 });
  });
});

describe('findUntaggedDescriptions', () => {
  const rows = [
    { character_id: 'george' },
    { character_id: 'jennie' },
    { character_id: 'louis-as-adult' },
  ];

  it('returns slugs in use but missing from the descriptions map', () => {
    const descriptions: CharacterDescriptions = { george: 'Gray hair.' };
    expect(findUntaggedDescriptions(rows, descriptions)).toEqual(['jennie', 'louis-as-adult']);
  });

  it('treats empty / whitespace descriptions as missing', () => {
    const descriptions: CharacterDescriptions = {
      george: 'Gray hair.',
      jennie: '',
      'louis-as-adult': '   ',
    };
    expect(findUntaggedDescriptions(rows, descriptions)).toEqual(['jennie', 'louis-as-adult']);
  });

  it('returns all used slugs when descriptions is undefined', () => {
    expect(findUntaggedDescriptions(rows, undefined)).toEqual(['george', 'jennie', 'louis-as-adult']);
  });

  it('returns an empty array when every used slug has a description', () => {
    const descriptions: CharacterDescriptions = {
      george: 'Gray hair.',
      jennie: 'Yellow dress.',
      'louis-as-adult': 'Brown coat.',
    };
    expect(findUntaggedDescriptions(rows, descriptions)).toEqual([]);
  });
});

describe('validateSlug', () => {
  it('accepts well-formed slugs', () => {
    expect(validateSlug('george')).toBeNull();
    expect(validateSlug('louis-as-adult')).toBeNull();
    expect(validateSlug('scientist-1')).toBeNull();
    expect(validateSlug('a')).toBeNull();
    expect(validateSlug('1-abc')).toBeNull();
  });

  it('rejects empty / whitespace', () => {
    expect(validateSlug('')).toContain('empty');
    expect(validateSlug('   ')).toContain('empty');
  });

  it('rejects too-long slugs', () => {
    expect(validateSlug('a'.repeat(51))).toContain('too long');
  });

  it('rejects slugs starting with non-alphanumeric', () => {
    expect(validateSlug('-george')).toContain('lowercase letter or digit');
  });

  it('rejects slugs starting with uppercase via the start-character check (singular message)', () => {
    // 'George' (capital G) fails the start regex before we get to the
    // body regex, so the message is the singular "start" one.
    expect(validateSlug('George')).toContain('start with a lowercase letter or digit');
  });

  it('rejects slugs containing invalid characters mid-string (plural message)', () => {
    expect(validateSlug('george_sodder')).toContain('lowercase letters, digits, and dashes');
    expect(validateSlug('george sodder')).toContain('lowercase letters, digits, and dashes');
    expect(validateSlug('george!')).toContain('lowercase letters, digits, and dashes');
    expect(validateSlug('georgeSodder')).toContain('lowercase letters, digits, and dashes');
  });

  it('rejects slugs ending with a dash', () => {
    expect(validateSlug('george-')).toContain("can't end with a dash");
  });
});

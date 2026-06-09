import { describe, expect, it } from 'vitest';
import {
  buildNativeShortSeoPrompt,
  buildShortSeoPrompt,
  normaliseYoutubeTags,
  parseShortSeoResult,
} from '@/lib/shorts-seo';

describe('buildShortSeoPrompt', () => {
  it('embeds the entered details and omits the source-video blocks when absent', () => {
    const { system, user } = buildShortSeoPrompt({
      enteredTitle: 'My amazing short',
      enteredDescription: 'A description here',
      lengthSeconds: 30,
      niche: 'AI tools',
    });
    expect(system).toContain('Shorts');
    expect(user).toContain('My amazing short');
    expect(user).toContain('A description here');
    expect(user).toContain('30 seconds');
    expect(user).toContain('AI tools');
    // No source video → neither context block is present.
    expect(user).not.toContain('Source long-form video');
    expect(user).not.toContain('Source video script');
  });

  it('includes the source video title + script when supplied', () => {
    const { user } = buildShortSeoPrompt({
      enteredTitle: 't',
      enteredDescription: 'd',
      lengthSeconds: 45,
      niche: 'n',
      sourceVideoTitle: 'The Parent Video',
      sourceVideoScript: 'word '.repeat(5000),
    });
    expect(user).toContain('The Parent Video');
    expect(user).toContain('Source video script');
    // Script is sliced to 4000 chars to keep the prompt bounded — the full
    // 25k-char input must not pass through verbatim.
    const scriptStart = user.indexOf('Source video script');
    // Full 25k-char input would blow past this; 4000-char slice + the JSON
    // schema tail stays well under 8000.
    expect(user.slice(scriptStart).length).toBeLessThan(8000);
    expect(user).not.toContain('word '.repeat(900));
  });
});

describe('parseShortSeoResult', () => {
  const valid = JSON.stringify({
    primary_keyword: 'ai tools',
    titles: [
      { text: 'Title A', score: 88, rationale: 'strong hook' },
      { text: 'Title B', score: 60, rationale: 'ok' },
    ],
    descriptions: [{ text: 'Desc A', score: 70, rationale: 'fine' }],
    hashtag_sets: [{ tags: ['Shorts', '#AItools', 'gpt 5'], score: 75, rationale: 'broad+niche' }],
    notes: 'overall good',
  });

  it('parses a clean response', () => {
    const r = parseShortSeoResult(valid);
    expect(r.primary_keyword).toBe('ai tools');
    expect(r.titles).toHaveLength(2);
    expect(r.descriptions).toHaveLength(1);
    expect(r.notes).toBe('overall good');
  });

  it('strips leading # and inner spaces from hashtags', () => {
    const r = parseShortSeoResult(valid);
    expect(r.hashtag_sets[0]!.tags).toEqual(['Shorts', 'AItools', 'gpt5']);
  });

  it('clamps and rounds scores into 0-100 integers', () => {
    const raw = JSON.stringify({
      titles: [
        { text: 'over', score: 150 },
        { text: 'under', score: -20 },
        { text: 'frac', score: 72.6 },
        { text: 'nan', score: 'abc' },
      ],
    });
    const r = parseShortSeoResult(raw);
    expect(r.titles.map(t => t.score)).toEqual([100, 0, 73, 0]);
  });

  it('drops options with empty text and hashtag sets with no tags', () => {
    const raw = JSON.stringify({
      titles: [{ text: 'keep', score: 50 }, { text: '   ', score: 90 }],
      hashtag_sets: [{ tags: [], score: 80 }, { tags: ['ok'], score: 60 }],
    });
    const r = parseShortSeoResult(raw);
    expect(r.titles).toHaveLength(1);
    expect(r.titles[0]!.text).toBe('keep');
    expect(r.hashtag_sets).toHaveLength(1);
  });

  it('tolerates fenced JSON with surrounding prose', () => {
    const raw = 'Here you go:\n```json\n' + valid + '\n```\nHope that helps!';
    const r = parseShortSeoResult(raw);
    expect(r.titles).toHaveLength(2);
  });

  it('throws when there are no usable title options', () => {
    expect(() => parseShortSeoResult(JSON.stringify({ titles: [] }))).toThrow(/no usable title/i);
    expect(() => parseShortSeoResult('not json at all')).toThrow(/parse/i);
  });

  // YouTube TAGS (the upload metadata field) — separate from hashtag_sets,
  // landed 2026-06-10. Optional in the schema; absent ⇒ [] so legacy
  // rows keep parsing.
  describe('YouTube tags field', () => {
    it('parses a tags array of multi-word phrases', () => {
      const raw = JSON.stringify({
        titles: [{ text: 'k', score: 50 }],
        tags: ['smishing scam text', 'fake USPS delivery', 'package phishing'],
      });
      const r = parseShortSeoResult(raw);
      expect(r.tags).toEqual(['smishing scam text', 'fake USPS delivery', 'package phishing']);
    });

    it('returns [] when the tags field is missing (legacy rows)', () => {
      const raw = JSON.stringify({ titles: [{ text: 'k', score: 50 }] });
      const r = parseShortSeoResult(raw);
      expect(r.tags).toEqual([]);
    });

    it('returns [] for malformed types instead of throwing', () => {
      const raw = JSON.stringify({
        titles: [{ text: 'k', score: 50 }],
        tags: 'not an array',
      });
      expect(parseShortSeoResult(raw).tags).toEqual([]);
    });
  });
});

describe('normaliseYoutubeTags', () => {
  it('strips leading # if the LLM ignored the prompt', () => {
    expect(normaliseYoutubeTags(['#smishing', '##USPS'])).toEqual(['smishing', 'USPS']);
  });

  it('keeps multi-word phrases (unlike hashtag normalisation)', () => {
    expect(normaliseYoutubeTags(['smishing scam', 'fake USPS text']))
      .toEqual(['smishing scam', 'fake USPS text']);
  });

  it('drops blanks, drops non-strings, drops "Shorts"', () => {
    expect(normaliseYoutubeTags(['', '   ', null, 42, 'Shorts', 'shorts', 'real']))
      .toEqual(['real']);
  });

  it('dedupes case-insensitively keeping the first form seen', () => {
    expect(normaliseYoutubeTags(['USPS scam', 'usps scam', 'USPS Scam']))
      .toEqual(['USPS scam']);
  });

  it('caps the array at 30 tags', () => {
    const many = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    expect(normaliseYoutubeTags(many)).toHaveLength(30);
  });

  it('caps each tag at 100 chars (YouTube per-tag hard limit)', () => {
    const huge = 'a'.repeat(250);
    expect(normaliseYoutubeTags([huge])[0]).toHaveLength(100);
  });

  it('collapses internal whitespace to single spaces', () => {
    expect(normaliseYoutubeTags(['  smishing    scam   text  ']))
      .toEqual(['smishing scam text']);
  });

  it('returns [] for non-array input', () => {
    expect(normaliseYoutubeTags(undefined)).toEqual([]);
    expect(normaliseYoutubeTags(null)).toEqual([]);
    expect(normaliseYoutubeTags('not an array')).toEqual([]);
    expect(normaliseYoutubeTags(42)).toEqual([]);
  });
});

describe('buildNativeShortSeoPrompt', () => {
  it('embeds the niche, hook, payoff and script body', () => {
    const { user } = buildNativeShortSeoPrompt({
      shortScript: 'Stop tying your shoes that way. Here is why the granny knot fails.',
      hook: "You're tying your shoes wrong.",
      payoff: 'Loop the second twist away.',
      lengthSeconds: 35,
      niche: 'life hacks',
    });
    expect(user).toContain('life hacks');
    expect(user).toContain("You're tying your shoes wrong");
    expect(user).toContain('Loop the second twist away');
    expect(user).toContain('35 seconds');
    expect(user).toContain('Stop tying your shoes');
  });

  it('includes the source video title when supplied', () => {
    const { user } = buildNativeShortSeoPrompt({
      shortScript: 'x',
      lengthSeconds: 30,
      niche: 'n',
      sourceVideoTitle: 'Long-form parent',
    });
    expect(user).toContain('Long-form parent');
  });

  it('omits the source video block when absent', () => {
    const { user } = buildNativeShortSeoPrompt({
      shortScript: 'x',
      lengthSeconds: 30,
      niche: 'n',
    });
    expect(user).not.toContain('Source long-form video');
  });

  it('caps the script body in the prompt to keep budgets sane', () => {
    const huge = 'word '.repeat(5000);
    const { user } = buildNativeShortSeoPrompt({
      shortScript: huge,
      lengthSeconds: 45,
      niche: 'n',
    });
    // The slice keeps the user prompt manageable — script body excerpt
    // shouldn't be the full 25K-word input.
    expect(user.length).toBeLessThan(10_000);
  });

  it('mandates the Phase 0 verified rules: no #Shorts in title/desc + ≤150 char description', () => {
    const { system } = buildNativeShortSeoPrompt({
      shortScript: 'x',
      lengthSeconds: 30,
      niche: 'n',
    });
    expect(system).toMatch(/DO NOT inject #Shorts/);
    expect(system).toMatch(/≤?150 characters?|150 char/);
    expect(system).toMatch(/3 to 5 hashtags|3-5 hashtags/);
    expect(system).toMatch(/No chapters|don't render/);
  });

  it('reuses the same output shape as the external_seo flow', () => {
    const { system, user } = buildNativeShortSeoPrompt({
      shortScript: 'x',
      lengthSeconds: 30,
      niche: 'n',
    });
    // Both prompts demand the same JSON keys (primary_keyword, titles,
    // descriptions, hashtag_sets, notes) so `parseShortSeoResult` can be
    // reused without a sibling parser.
    for (const key of ['primary_keyword', 'titles', 'descriptions', 'hashtag_sets', 'notes']) {
      expect(user, key).toContain(key);
    }
    // System prompt demands STRICT JSON.
    expect(system).toMatch(/STRICT JSON/);
  });
});

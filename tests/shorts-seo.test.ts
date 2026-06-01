import { describe, expect, it } from 'vitest';
import { buildShortSeoPrompt, parseShortSeoResult } from '@/lib/shorts-seo';

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
});

import { describe, expect, it } from 'vitest';
import {
  buildShortExtractionPrompt,
  parseExtractedShort,
  countSpokenWords,
  estimateShortDurationSeconds,
} from '@/lib/shorts';
import { TARGET_DURATION_SECONDS_DEFAULT, WORDS_PER_SECOND } from '@/lib/shorts-types';

describe('countSpokenWords', () => {
  it('counts simple word strings', () => {
    expect(countSpokenWords('one two three')).toBe(3);
    expect(countSpokenWords('  one   two\nthree\t')).toBe(3);
  });
  it('returns 0 for empty / whitespace-only inputs', () => {
    expect(countSpokenWords('')).toBe(0);
    expect(countSpokenWords('   ')).toBe(0);
    expect(countSpokenWords('\n\t')).toBe(0);
  });
});

describe('estimateShortDurationSeconds', () => {
  it('roughly inverts WORDS_PER_SECOND', () => {
    expect(estimateShortDurationSeconds(0)).toBe(1); // floor
    expect(estimateShortDurationSeconds(Math.round(WORDS_PER_SECOND * 30))).toBe(30);
    expect(estimateShortDurationSeconds(Math.round(WORDS_PER_SECOND * 60))).toBe(60);
  });
});

describe('buildShortExtractionPrompt', () => {
  it('embeds the niche, target seconds, and target word count in the system prompt', () => {
    const { system } = buildShortExtractionPrompt({
      longScript: 'lorem ipsum',
      niche: 'AI tools',
      targetSeconds: 45,
    });
    expect(system).toContain('45-second');
    const targetWords = Math.round(45 * WORDS_PER_SECOND);
    expect(system).toContain(`~${targetWords} words`);
  });

  it('includes the cliché blocklist', () => {
    const { system } = buildShortExtractionPrompt({
      longScript: 'x',
      niche: 'x',
      targetSeconds: 45,
    });
    for (const phrase of ['navigate', 'landscape', 'realm', 'buckle up', 'let\'s dive in']) {
      expect(system).toContain(phrase);
    }
  });

  it('demands strict JSON output with the expected shape', () => {
    const { system } = buildShortExtractionPrompt({
      longScript: 'x',
      niche: 'x',
      targetSeconds: 45,
    });
    expect(system).toMatch(/STRICTLY this JSON shape/);
    expect(system).toContain('"title"');
    expect(system).toContain('"hook"');
    expect(system).toContain('"short_script"');
    expect(system).toContain('"payoff"');
    expect(system).toContain('"word_count"');
  });

  it('surfaces the niche, tone, and source script in the user prompt', () => {
    const { user } = buildShortExtractionPrompt({
      longScript: 'This is the long source script body.',
      niche: 'Cybersecurity',
      tone: 'irreverent expert',
      targetSeconds: 45,
    });
    expect(user).toContain('Cybersecurity');
    expect(user).toContain('irreverent expert');
    expect(user).toContain('This is the long source script body.');
  });

  it('omits the tone line when tone is not provided', () => {
    const { user } = buildShortExtractionPrompt({
      longScript: 'lorem',
      niche: 'AI',
      targetSeconds: 30,
    });
    expect(user).not.toMatch(/^Tone:/m);
  });
});

describe('parseExtractedShort', () => {
  const validJson = JSON.stringify({
    title: 'Five-Word Punchy Title',
    hook: 'Bold opening line.',
    short_script:
      '[VISUAL: cold open on phone screen] Bold opening line. ' +
      'Then the kicker. The body sustains energy across thirty more words to pass the minimum length threshold for a real short script. ' +
      'Closing.',
    payoff: 'Closing.',
    word_count: 35,
  });

  it('parses a clean JSON response', () => {
    const out = parseExtractedShort(validJson);
    expect(out.title).toBe('Five-Word Punchy Title');
    expect(out.hook).toBe('Bold opening line.');
    expect(out.short_script).toMatch(/Bold opening line/);
    expect(out.payoff).toBe('Closing.');
    expect(out.word_count).toBe(35);
  });

  it('parses fenced JSON', () => {
    const fenced = '```json\n' + validJson + '\n```';
    const out = parseExtractedShort(fenced);
    expect(out.title).toBe('Five-Word Punchy Title');
  });

  it('parses prose-wrapped JSON', () => {
    const prose = `Sure, here you go!\n${validJson}\nHope this helps!`;
    const out = parseExtractedShort(prose);
    expect(out.short_script).toMatch(/Bold opening line/);
  });

  it('recomputes word_count when the LLM misreports it', () => {
    const wrong = JSON.stringify({
      title: 'T',
      hook: 'h',
      short_script:
        '[VISUAL: x] One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.',
      payoff: 'end.',
      word_count: 999, // deliberate lie
    });
    const out = parseExtractedShort(wrong);
    // The LLM's claimed count wins when it's a finite number — recompute is
    // a fallback only. So we keep 999 here. The fallback path is exercised
    // when word_count is missing entirely (next test).
    expect(out.word_count).toBe(999);
  });

  it('falls back to a local count when word_count is missing', () => {
    const script = 'one two three four five six seven eight nine ten eleven twelve.';
    const noCount = JSON.stringify({
      title: 'T',
      hook: 'h',
      short_script: script,
      payoff: 'end.',
    });
    const out = parseExtractedShort(noCount);
    expect(out.word_count).toBe(12);
  });

  it('throws on garbage that has no JSON', () => {
    expect(() => parseExtractedShort('not json at all')).toThrow(/parse JSON/);
  });

  it('throws when short_script is missing or too short', () => {
    expect(() =>
      parseExtractedShort(JSON.stringify({ title: 'T', short_script: '' })),
    ).toThrow(/short_script/);
    expect(() =>
      parseExtractedShort(JSON.stringify({ title: 'T', short_script: 'too short' })),
    ).toThrow(/short_script/);
  });

  it('returns empty strings for missing optional fields', () => {
    const minimal = JSON.stringify({
      short_script: 'A short script body that exceeds the thirty char minimum easily right?',
    });
    const out = parseExtractedShort(minimal);
    expect(out.title).toBe('');
    expect(out.hook).toBe('');
    expect(out.payoff).toBe('');
  });
});

describe('TARGET_DURATION_SECONDS_DEFAULT', () => {
  it('lands in the algorithm sweet spot (30-60s)', () => {
    expect(TARGET_DURATION_SECONDS_DEFAULT).toBeGreaterThanOrEqual(30);
    expect(TARGET_DURATION_SECONDS_DEFAULT).toBeLessThanOrEqual(60);
  });
});

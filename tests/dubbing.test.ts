import { describe, expect, it } from 'vitest';
import {
  isSupportedLanguage,
  buildTranslationPrompt,
  estimateDubDuration,
  SUPPORTED_LANGUAGES,
} from '@/lib/dubbing';

describe('isSupportedLanguage', () => {
  it('accepts every code in the supported list', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(isSupportedLanguage(lang.code)).toBe(true);
    }
  });

  it('rejects unknown codes', () => {
    expect(isSupportedLanguage('en')).toBe(false); // source, not target
    expect(isSupportedLanguage('zh')).toBe(false);
    expect(isSupportedLanguage('')).toBe(false);
    expect(isSupportedLanguage('SPANISH')).toBe(false); // case-sensitive on purpose
  });

  it('rejects pt without -BR (we only support pt-BR)', () => {
    expect(isSupportedLanguage('pt')).toBe(false);
    expect(isSupportedLanguage('pt-BR')).toBe(true);
  });

  it('matches the YouTube auto-dubbing 8 languages list', () => {
    const codes = SUPPORTED_LANGUAGES.map(l => l.code);
    expect(codes).toEqual(
      expect.arrayContaining(['es', 'pt-BR', 'fr', 'de', 'it', 'hi', 'id', 'ja']),
    );
    expect(codes.length).toBe(8);
  });
});

describe('buildTranslationPrompt', () => {
  it('embeds the target language label, not just the code', () => {
    const { system } = buildTranslationPrompt('Hello world.', 'es');
    expect(system).toContain('Spanish');
    expect(system).not.toContain('"es"');
  });

  it('preserves markup VERBATIM rule for [VISUAL CUE], [PAUSE], **bold**, ##', () => {
    const { system } = buildTranslationPrompt('Hello.', 'fr');
    expect(system).toMatch(/\[VISUAL CUE/);
    expect(system).toMatch(/\[PAUSE\]/);
    expect(system).toContain('**bold**');
    expect(system).toContain('## Section');
  });

  it('forbids quote-wrapping the response', () => {
    const { system } = buildTranslationPrompt('x', 'de');
    expect(system).toMatch(/DO NOT wrap the response in quotes/);
  });

  it('forbids translator notes / footnotes', () => {
    const { system } = buildTranslationPrompt('x', 'it');
    expect(system).toMatch(/DO NOT add explanatory notes/);
  });

  it('preserves brand names rule', () => {
    const { system } = buildTranslationPrompt('Watch on YouTube.', 'hi');
    expect(system).toMatch(/DO NOT translate brand names/);
  });

  it('passes the source text through as the user prompt unchanged', () => {
    const source = 'Hello.\n## Hook\nThis is a test.';
    const { user } = buildTranslationPrompt(source, 'ja');
    expect(user).toBe(source);
  });

  it('every supported language gets a labelled system prompt', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const { system } = buildTranslationPrompt('x', lang.code);
      expect(system).toContain(lang.label);
    }
  });
});

describe('estimateDubDuration', () => {
  it('returns at least 1 second for any input', () => {
    expect(estimateDubDuration(0)).toBe(1);
    expect(estimateDubDuration(1)).toBe(1);
    expect(estimateDubDuration(5)).toBe(1);
  });

  it('grows roughly linearly with character count (~13 chars/sec)', () => {
    expect(estimateDubDuration(130)).toBe(10);
    expect(estimateDubDuration(1300)).toBe(100);
    expect(estimateDubDuration(13000)).toBe(1000);
  });

  it('rounds rather than truncating', () => {
    expect(estimateDubDuration(20)).toBe(Math.round(20 / 13)); // 2
    expect(estimateDubDuration(19)).toBe(Math.round(19 / 13)); // 1
  });
});

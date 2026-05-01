import { describe, expect, it } from 'vitest';
import {
  parseBrandKit,
  isBrandKitNonEmpty,
  buildBrandKitPromptBlock,
  BRAND_KIT_VERSION,
} from '@/lib/channel-brand-kit';

describe('parseBrandKit', () => {
  it('returns defaults for non-objects', () => {
    expect(parseBrandKit(null)).toEqual({ v: BRAND_KIT_VERSION });
    expect(parseBrandKit(undefined)).toEqual({ v: BRAND_KIT_VERSION });
    expect(parseBrandKit('string')).toEqual({ v: BRAND_KIT_VERSION });
    expect(parseBrandKit(42)).toEqual({ v: BRAND_KIT_VERSION });
    expect(parseBrandKit([])).toEqual({ v: BRAND_KIT_VERSION });
  });

  it('returns defaults when the v mismatches (forward compat)', () => {
    expect(parseBrandKit({ v: 99, tone: 'warm' })).toEqual({ v: BRAND_KIT_VERSION });
  });

  it('treats a missing v as v=1 (legacy `{}` default)', () => {
    expect(parseBrandKit({ tone: 'warm' })).toEqual({ v: 1, tone: 'warm' });
  });

  it('reads scalar string fields when present and trimmed-non-empty', () => {
    const k = parseBrandKit({
      v: 1,
      tone: '  warm authority  ',
      hook_style: 'data-driven cold open',
      intro_template: 'Open mid-action',
      cta_template: 'subscribe + comment',
      outro_template: 'callback to opening',
    });
    expect(k.tone).toBe('warm authority');
    expect(k.hook_style).toBe('data-driven cold open');
    expect(k.intro_template).toBe('Open mid-action');
    expect(k.cta_template).toBe('subscribe + comment');
    expect(k.outro_template).toBe('callback to opening');
  });

  it('drops empty / whitespace-only string fields', () => {
    const k = parseBrandKit({ v: 1, tone: '   ', hook_style: '' });
    expect(k.tone).toBeUndefined();
    expect(k.hook_style).toBeUndefined();
  });

  it('only accepts vocabulary_level from the allowed enum', () => {
    expect(parseBrandKit({ v: 1, vocabulary_level: 'casual' }).vocabulary_level).toBe('casual');
    expect(parseBrandKit({ v: 1, vocabulary_level: 'professional' }).vocabulary_level).toBe(
      'professional',
    );
    expect(parseBrandKit({ v: 1, vocabulary_level: 'shouty' }).vocabulary_level).toBeUndefined();
  });

  it('only accepts sentence_length from the allowed enum', () => {
    expect(parseBrandKit({ v: 1, sentence_length: 'short' }).sentence_length).toBe('short');
    expect(parseBrandKit({ v: 1, sentence_length: 'mixed' }).sentence_length).toBe('mixed');
    expect(parseBrandKit({ v: 1, sentence_length: 'epic' }).sentence_length).toBeUndefined();
  });

  it('reads array fields, dropping non-strings, trimming, and filtering empties', () => {
    const k = parseBrandKit({
      v: 1,
      voice_examples: ['  hello  ', '', 42, null, 'world'],
      banned_phrases: ['buckle up', 'navigate'],
    });
    expect(k.voice_examples).toEqual(['hello', 'world']);
    expect(k.banned_phrases).toEqual(['buckle up', 'navigate']);
  });

  it('caps array fields at sane limits', () => {
    const big = Array.from({ length: 100 }, (_, i) => `phrase ${i}`);
    const k = parseBrandKit({ v: 1, banned_phrases: big });
    expect(k.banned_phrases).toHaveLength(50);
    expect(parseBrandKit({ v: 1, voice_examples: big }).voice_examples).toHaveLength(10);
    expect(parseBrandKit({ v: 1, required_phrases: big }).required_phrases).toHaveLength(25);
  });

  it('drops a non-array value silently', () => {
    expect(
      parseBrandKit({ v: 1, banned_phrases: 'not an array' }).banned_phrases,
    ).toBeUndefined();
  });
});

describe('isBrandKitNonEmpty', () => {
  it('returns false for the bare default', () => {
    expect(isBrandKitNonEmpty({ v: 1 })).toBe(false);
  });
  it('returns true when any scalar field is set', () => {
    expect(isBrandKitNonEmpty({ v: 1, tone: 'warm' })).toBe(true);
    expect(isBrandKitNonEmpty({ v: 1, hook_style: 'X' })).toBe(true);
    expect(isBrandKitNonEmpty({ v: 1, vocabulary_level: 'casual' })).toBe(true);
  });
  it('returns true when any array field has at least one element', () => {
    expect(isBrandKitNonEmpty({ v: 1, banned_phrases: ['x'] })).toBe(true);
  });
  it('returns false for empty arrays', () => {
    expect(isBrandKitNonEmpty({ v: 1, banned_phrases: [] })).toBe(false);
  });
});

describe('buildBrandKitPromptBlock', () => {
  it('returns empty string for null / undefined', () => {
    expect(buildBrandKitPromptBlock(null)).toBe('');
    expect(buildBrandKitPromptBlock(undefined)).toBe('');
  });

  it('returns empty string for a default kit', () => {
    expect(buildBrandKitPromptBlock({ v: 1 })).toBe('');
  });

  it('emits the heading + every populated field as a bullet', () => {
    const block = buildBrandKitPromptBlock({
      v: 1,
      tone: 'warm authority',
      vocabulary_level: 'conversational',
      sentence_length: 'mixed',
      voice_examples: ['Sample one.', 'Sample two.'],
      banned_phrases: ['buckle up'],
      required_phrases: ['no fluff, just facts'],
      hook_style: 'data-driven cold open',
      intro_template: 'mid-action',
      cta_template: 'subscribe + comment',
      outro_template: 'callback',
      topics_to_avoid: ['politics'],
      topics_to_emphasize: ['productivity'],
      brand_keywords: ['focus', 'flow'],
    });
    expect(block).toContain('## CHANNEL BRAND KIT');
    expect(block).toContain('Tone: warm authority');
    expect(block).toContain('Vocabulary level: conversational');
    expect(block).toContain('mixed —');
    expect(block).toContain('"Sample one."');
    expect(block).toContain('"buckle up"');
    expect(block).toContain('"no fluff, just facts"');
    expect(block).toContain('Hook recipe: data-driven cold open');
    expect(block).toContain('Topics to avoid: politics');
    expect(block).toContain('SEO keywords (work in naturally');
    expect(block).toContain('non-negotiable');
  });

  it('caps voice_examples at 5 in the rendered block', () => {
    const examples = Array.from({ length: 8 }, (_, i) => `example ${i}`);
    const block = buildBrandKitPromptBlock({ v: 1, voice_examples: examples });
    expect(block).toContain('"example 0"');
    expect(block).toContain('"example 4"');
    expect(block).not.toContain('"example 5"');
  });

  it('renders sentence_length notes that vary per option', () => {
    expect(buildBrandKitPromptBlock({ v: 1, sentence_length: 'short' })).toMatch(/short, punchy/);
    expect(buildBrandKitPromptBlock({ v: 1, sentence_length: 'long' })).toMatch(/longer rolling/);
    expect(buildBrandKitPromptBlock({ v: 1, sentence_length: 'mixed' })).toMatch(/alternate/);
    expect(buildBrandKitPromptBlock({ v: 1, sentence_length: 'medium' })).toMatch(/medium/);
  });
});

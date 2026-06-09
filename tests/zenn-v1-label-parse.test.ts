import { describe, expect, it } from 'vitest';
import { highlighterRgba, parseZennLabel } from '@/remotion/zenn-label-parse';

// ─── parseZennLabel ─────────────────────────────────────────────────
//
// The parser is the bridge between the LLM's `[hl]word[/hl]` markup
// and the renderer's per-segment span list. Bugs here either drop
// characters (the highlighted word disappears) or render markup
// literally (the user sees `[hl]` on screen). Pinning every branch.

describe('parseZennLabel — basic', () => {
  it('returns one unhighlighted segment for plain text', () => {
    expect(parseZennLabel('hello world')).toEqual([
      { text: 'hello world', highlighted: false },
    ]);
  });

  it('returns one empty unhighlighted segment for empty input', () => {
    expect(parseZennLabel('')).toEqual([{ text: '', highlighted: false }]);
  });

  it('handles undefined and null input', () => {
    expect(parseZennLabel(undefined)).toEqual([{ text: '', highlighted: false }]);
    expect(parseZennLabel(null)).toEqual([{ text: '', highlighted: false }]);
  });

  it('handles non-string input defensively', () => {
    // The doc JSON should always carry strings here, but a stale
    // doc shape (a row migrated from a different format) could
    // carry a number or boolean. The renderer should never throw.
    expect(parseZennLabel(123 as never)).toEqual([
      { text: '', highlighted: false },
    ]);
  });
});

describe('parseZennLabel — single [hl] marker', () => {
  it('splits "[hl]word[/hl]" into one highlighted segment', () => {
    expect(parseZennLabel('[hl]word[/hl]')).toEqual([
      { text: 'word', highlighted: true },
    ]);
  });

  it('keeps the leading unhighlighted prefix', () => {
    expect(parseZennLabel('the [hl]word[/hl]')).toEqual([
      { text: 'the ', highlighted: false },
      { text: 'word', highlighted: true },
    ]);
  });

  it('keeps the trailing unhighlighted suffix', () => {
    expect(parseZennLabel('[hl]word[/hl] is the point')).toEqual([
      { text: 'word', highlighted: true },
      { text: ' is the point', highlighted: false },
    ]);
  });

  it('keeps both prefix and suffix around a single highlight', () => {
    expect(parseZennLabel('EVERYONE. [hl]ALL AT ONCE[/hl].')).toEqual([
      { text: 'EVERYONE. ', highlighted: false },
      { text: 'ALL AT ONCE', highlighted: true },
      { text: '.', highlighted: false },
    ]);
  });

  it('preserves whitespace inside a highlighted segment', () => {
    expect(parseZennLabel('[hl]two  words[/hl]')).toEqual([
      { text: 'two  words', highlighted: true },
    ]);
  });
});

describe('parseZennLabel — multiple [hl] markers', () => {
  it('handles two highlights separated by plain text', () => {
    expect(parseZennLabel('a [hl]b[/hl] c [hl]d[/hl] e')).toEqual([
      { text: 'a ', highlighted: false },
      { text: 'b', highlighted: true },
      { text: ' c ', highlighted: false },
      { text: 'd', highlighted: true },
      { text: ' e', highlighted: false },
    ]);
  });

  it('handles adjacent highlights with no gap', () => {
    expect(parseZennLabel('[hl]a[/hl][hl]b[/hl]')).toEqual([
      { text: 'a', highlighted: true },
      { text: 'b', highlighted: true },
    ]);
  });
});

describe('parseZennLabel — malformed markers', () => {
  it('renders an open-without-close marker as literal text', () => {
    // The whole input is just one unhighlighted segment.
    expect(parseZennLabel('hello [hl]oops')).toEqual([
      { text: 'hello [hl]oops', highlighted: false },
    ]);
  });

  it('renders a stray closing marker as literal text', () => {
    expect(parseZennLabel('hello [/hl] oops')).toEqual([
      { text: 'hello [/hl] oops', highlighted: false },
    ]);
  });

  it('skips empty [hl][/hl] markers entirely', () => {
    // Empty markers are noise — they shouldn't render an empty
    // highlighter span. Renderer-side they would be invisible
    // anyway, but skipping them keeps the segment list cleaner
    // and makes downstream tests deterministic.
    expect(parseZennLabel('before [hl][/hl] after')).toEqual([
      { text: 'before ', highlighted: false },
      { text: ' after', highlighted: false },
    ]);
  });
});

// ─── highlighterRgba ────────────────────────────────────────────────
//
// The rgba helper converts the stored hex color into a renderer-
// ready translucent string. The 0.65 alpha is canonical (plan §8)
// and must be applied at the renderer, not at storage time, so a
// stale stored value can't accidentally produce an opaque block
// over the word.

describe('highlighterRgba', () => {
  it('converts a valid hex to rgba with 0.65 alpha', () => {
    expect(highlighterRgba('#FFE840')).toBe('rgba(255, 232, 64, 0.65)');
    expect(highlighterRgba('#000000')).toBe('rgba(0, 0, 0, 0.65)');
    expect(highlighterRgba('#FFFFFF')).toBe('rgba(255, 255, 255, 0.65)');
  });

  it('falls back to the canonical default for missing input', () => {
    expect(highlighterRgba(undefined)).toBe('rgba(255, 232, 64, 0.65)');
  });

  it('falls back to the canonical default for malformed hex', () => {
    for (const bad of ['', 'red', '#FFF', '#1234567', 'EBC347', '#GGGGGG']) {
      expect(highlighterRgba(bad)).toBe('rgba(255, 232, 64, 0.65)');
    }
  });

  it('handles non-string input defensively', () => {
    expect(highlighterRgba(123 as never)).toBe('rgba(255, 232, 64, 0.65)');
    expect(highlighterRgba(null as never)).toBe('rgba(255, 232, 64, 0.65)');
  });
});

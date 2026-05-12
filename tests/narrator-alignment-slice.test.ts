/**
 * Locks down the forced-alignment slicing helpers used by the Narration tab's
 * synced player.
 *
 *   1. `buildAlignmentScript` must produce the same bytes that get POSTed to
 *      ElevenLabs — production cues stripped per section, sections joined
 *      with `\n`, empty sections skipped. The slicer below has to count
 *      words the same way for the per-section split to be correct.
 *   2. `sliceAlignmentToSections` distributes the aligner's flat word array
 *      back across the sections by word count. Spacing-type tokens are
 *      ignored. Trailing sections degrade gracefully when the aligner
 *      returns fewer words than the script has.
 *   3. `findActiveWordIndex` binary-searches by audio time. Returns -1 when
 *      the time falls in a gap between words.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAlignmentScript,
  findActiveWordIndex,
  sliceAlignmentToSections,
  type ScriptSection,
} from '@/lib/narrator-utils';
import type { ForcedAlignmentResponse, ForcedAlignmentWord } from '@/lib/elevenlabs';

function section(scriptText: string, label?: string): ScriptSection {
  return {
    label,
    script_text: scriptText,
    estimated_duration_seconds: 0,
    emphasis_markers: [],
  };
}

function word(text: string, start: number, end: number, loss?: number): ForcedAlignmentWord {
  return { text, start, end, ...(loss !== undefined ? { loss } : {}) };
}

describe('buildAlignmentScript', () => {
  it('strips bracket cues, joins sections with newlines', () => {
    const sections = [
      section('Hello [pause] world.'),
      section('[VISUAL: cut] Second section.'),
    ];
    const out = buildAlignmentScript(sections);
    expect(out).toBe('Hello  world.\nSecond section.');
  });

  it('skips sections that are pure production cues', () => {
    const sections = [
      section('Real spoken text.'),
      section('[outro music]'),
      section('More text.'),
    ];
    const out = buildAlignmentScript(sections);
    expect(out).toBe('Real spoken text.\nMore text.');
  });
});

describe('sliceAlignmentToSections', () => {
  it('splits the flat word array by per-section spoken-word count', () => {
    const sections = [
      section('Hello world.'),     // 2 words
      section('How are you doing?'), // 4 words
    ];
    const words = [
      word('Hello', 0.0, 0.4),
      word('world.', 0.4, 0.9),
      word('How', 1.0, 1.2),
      word('are', 1.2, 1.4),
      word('you', 1.4, 1.6),
      word('doing?', 1.6, 2.1),
    ];
    const alignment: ForcedAlignmentResponse = { words };
    const sliced = sliceAlignmentToSections(alignment, sections);

    expect(sliced).toHaveLength(2);
    expect(sliced[0].sectionIndex).toBe(0);
    expect(sliced[0].words.map((w) => w.text)).toEqual(['Hello', 'world.']);
    expect(sliced[1].sectionIndex).toBe(1);
    expect(sliced[1].words.map((w) => w.text)).toEqual(['How', 'are', 'you', 'doing?']);
  });

  it('treats production cues as zero spoken words and accounts for them', () => {
    const sections = [
      section('One [pause] two.'),    // 2 spoken words (One, two.)
      section('Three [SFX] four.'),   // 2 spoken words (Three, four.)
    ];
    const words = [
      word('One', 0, 0.3),
      word('two.', 0.4, 0.7),
      word('Three', 1.0, 1.3),
      word('four.', 1.4, 1.7),
    ];
    const sliced = sliceAlignmentToSections({ words }, sections);
    expect(sliced[0].words.map((w) => w.text)).toEqual(['One', 'two.']);
    expect(sliced[1].words.map((w) => w.text)).toEqual(['Three', 'four.']);
  });

  it('ignores spacing-type whitespace-only tokens before slicing', () => {
    const sections = [section('Hi there.')]; // 2 spoken words
    const words: ForcedAlignmentWord[] = [
      word('Hi', 0, 0.2),
      word(' ', 0.2, 0.21),     // would be a "spacing" entry from the API
      word('there.', 0.21, 0.5),
    ];
    const sliced = sliceAlignmentToSections({ words }, sections);
    expect(sliced[0].words.map((w) => w.text)).toEqual(['Hi', 'there.']);
  });

  it('degrades gracefully when the aligner returns fewer words than the script', () => {
    const sections = [
      section('Long first section with five words.'), // 6 words
      section('Trailing section.'),                   // 2 words
    ];
    const words = [
      word('Long', 0, 0.2),
      word('first', 0.2, 0.4),
      word('section', 0.4, 0.7),
      // aligner cut off mid-stream — only 3 words for section 0, none for section 1
    ];
    const sliced = sliceAlignmentToSections({ words }, sections);
    expect(sliced[0].words).toHaveLength(3);
    expect(sliced[1].words).toHaveLength(0);
  });
});

describe('findActiveWordIndex', () => {
  const words = [
    word('a', 0.0, 0.4),
    word('b', 0.5, 0.9),
    word('c', 1.0, 1.5),
    word('d', 1.5, 2.0),
  ];

  it('returns the word whose [start, end) contains the time', () => {
    expect(findActiveWordIndex(words, 0.0)).toBe(0);
    expect(findActiveWordIndex(words, 0.3)).toBe(0);
    expect(findActiveWordIndex(words, 0.7)).toBe(1);
    expect(findActiveWordIndex(words, 1.49)).toBe(2);
    expect(findActiveWordIndex(words, 1.5)).toBe(3); // end is exclusive, next word starts
  });

  it('returns -1 for a gap between words', () => {
    expect(findActiveWordIndex(words, 0.45)).toBe(-1); // between a (ends 0.4) and b (starts 0.5)
  });

  it('returns -1 before the first word and after the last', () => {
    expect(findActiveWordIndex(words, -1)).toBe(-1);
    expect(findActiveWordIndex(words, 2.1)).toBe(-1);
  });

  it('returns -1 on an empty word list', () => {
    expect(findActiveWordIndex([], 0.5)).toBe(-1);
  });
});

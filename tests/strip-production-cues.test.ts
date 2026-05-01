import { describe, expect, it } from 'vitest';
import { stripProductionCues, countWords } from '@/lib/utils';
import { splitScriptIntoSections } from '@/lib/narrator-utils';

/**
 * Regression coverage for the narrator's "what do I actually say?" pipeline.
 *
 * The script generator (and the user's downstream LLM tooling) injects a
 * variety of non-spoken content into drafts: bracketed visual / SFX /
 * pacing cues, citation markers, markdown headers, markdown emphasis, and
 * — critically — running word-count annotations like `(Spoken words: 84)`
 * and the trailing `**TOTAL SPOKEN WORD COUNT: 1570** (...)` line. These
 * are useful while writing but disastrous when surfaced to the narrator,
 * who otherwise reads them out loud verbatim.
 *
 * stripProductionCues() is the single canonical scrub used by the
 * generator UI, narrator portal, teleprompter, exports, and dashboard
 * counts. These tests pin its behaviour to keep all those views aligned.
 */

describe('stripProductionCues — bracketed cues', () => {
  it('strips visual cues, SFX, pause, and B-roll markers', () => {
    const input = '[VISUAL CUE: open in browser] Click. [SFX: alarm] [PAUSE] Done. [B-ROLL: laptop]';
    expect(stripProductionCues(input)).toBe('Click.   Done.');
  });

  it('strips ElevenLabs-style performance tags', () => {
    expect(stripProductionCues('[whisper] Quietly. [excited] But now! [pause]')).toBe(
      'Quietly.  But now!',
    );
  });

  it('strips Perplexity-style citation markers', () => {
    expect(stripProductionCues('Hit 2.3 million users in 2022 alone.[1][2] Victims click.[3]')).toBe(
      'Hit 2.3 million users in 2022 alone. Victims click.',
    );
  });

  it('strips empty brackets without leaving trailing characters', () => {
    expect(stripProductionCues('Hello [] world')).toBe('Hello  world');
  });
});

describe('stripProductionCues — word-count metadata (the bug from the user report)', () => {
  it('strips a "(Word count so far: ...)" line', () => {
    const input = `Some narration text here.

(Word count so far: Opening 28 + Intro 72 = 100 spoken words)

More narration.`;
    const out = stripProductionCues(input);
    expect(out).not.toMatch(/Word count/i);
    expect(out).not.toMatch(/100 spoken words/);
    expect(out).toContain('Some narration text here.');
    expect(out).toContain('More narration.');
  });

  it('strips a "(Spoken words: 84)" line', () => {
    const input = `Last paragraph of the section.

(Spoken words: 84)`;
    const out = stripProductionCues(input);
    expect(out).toBe('Last paragraph of the section.');
  });

  it('strips the closing "**TOTAL SPOKEN WORD COUNT: 1570** (...)" line', () => {
    const input = `Final outro line.

**TOTAL SPOKEN WORD COUNT: 1570** (Opening 28 + Intro 84 + Main 1045 [310+315+328+315=1268] + Outro 118 = 1498. Excludes all [brackets]. Verified.)`;
    const out = stripProductionCues(input);
    expect(out).toBe('Final outro line.');
    expect(out).not.toMatch(/TOTAL SPOKEN/);
    expect(out).not.toMatch(/Verified/);
  });

  it('strips inline parenthetical metadata mid-paragraph', () => {
    const input = 'End of paragraph.(Spoken words: 310) Next sentence.';
    expect(stripProductionCues(input)).toBe('End of paragraph. Next sentence.');
  });

  it('does NOT strip parens that just happen to mention numbers (only metadata phrases)', () => {
    const input = 'The result (a 47% drop in clicks) was striking.';
    expect(stripProductionCues(input)).toBe('The result (a 47% drop in clicks) was striking.');
  });

  it('strips both the wrapping bold AND the metadata parens together', () => {
    // The actual closing line shape from the user's example.
    const input = '**TOTAL SPOKEN WORD COUNT: 1570** (Opening 28 + Intro 84)';
    expect(stripProductionCues(input)).toBe('');
  });
});

describe('stripProductionCues — markdown', () => {
  it('strips standalone markdown header lines', () => {
    const input = `## Fake Online Scanners

Body text here.

### Sub-section

More body.`;
    const out = stripProductionCues(input);
    expect(out).not.toMatch(/^##/m);
    expect(out).not.toMatch(/^###/m);
    expect(out).toContain('Body text here.');
    expect(out).toContain('More body.');
  });

  it('keeps the inner words but strips bold/italic markers', () => {
    expect(stripProductionCues('**Lights flash. Panic hits.**')).toBe('Lights flash. Panic hits.');
    expect(stripProductionCues('Use *italic* and __also bold__ here')).toBe(
      'Use italic and also bold here',
    );
  });

  it('does not strip asterisks that are not paired', () => {
    // Heuristic: only paired emphasis is stripped. A lone `*` (e.g. a typo
    // or a footnote marker) survives, which is the correct conservative
    // default — bold is always paired.
    expect(stripProductionCues('Rate * 5 stars')).toBe('Rate * 5 stars');
  });

  it('strips bold even when it spans the whole paragraph', () => {
    expect(stripProductionCues('**Real AV stays quiet. Tray icon only.**')).toBe(
      'Real AV stays quiet. Tray icon only.',
    );
  });
});

describe('stripProductionCues — full user-reported script', () => {
  // The exact closing block from the script the user shared. After scrub,
  // the narrator should see only the spoken outro text — no headers, no
  // running counts, no markdown asterisks, no SFX cues.
  const closing = `## Outro

Back to that first pop-up. Screen red, heart racing. Now you know—it's not infection. It's engineered fear.[1][6]

Real protection's quiet. No screams, no countdowns.[2][3] Spot one? Close browser hard—Ctrl+Shift+Esc.

Next time a "threat" flashes—smile. You're armed.

(Spoken words: 118)

**TOTAL SPOKEN WORD COUNT: 1570** (Opening 28 + Intro 84 + Main 1045 [310+315+328+315=1268] + Outro 118 = 1498. Excludes all [brackets]. Verified.)`;

  it('returns only the spoken outro lines', () => {
    const out = stripProductionCues(closing);

    // Things that MUST be gone:
    expect(out).not.toMatch(/##/);
    expect(out).not.toMatch(/Spoken words:/i);
    expect(out).not.toMatch(/TOTAL SPOKEN/i);
    expect(out).not.toMatch(/Verified/);
    expect(out).not.toMatch(/\[\d+\]/); // no [1], [6], etc.
    expect(out).not.toMatch(/\*\*/); // no markdown asterisks

    // Things that MUST remain:
    expect(out).toContain('Back to that first pop-up.');
    expect(out).toContain("Real protection's quiet.");
    expect(out).toContain("Next time a \"threat\" flashes—smile. You're armed.");
  });

  it('countWords on the closing block matches the human-counted outro length within tolerance', () => {
    // Outro is ~40 words of actual narration (the closing block above is
    // shorter than the full 118-word outro from the user). What matters
    // is that the count excludes all the metadata + citations + headers.
    const count = countWords(closing);
    expect(count).toBeGreaterThan(30);
    expect(count).toBeLessThan(60);
  });
});

describe('countWords', () => {
  it('returns 0 for an empty / nullish / metadata-only string', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('[VISUAL CUE: just a cue]')).toBe(0);
    expect(countWords('(Spoken words: 84)')).toBe(0);
    expect(countWords('## Just a heading')).toBe(0);
    expect(countWords('**TOTAL SPOKEN WORD COUNT: 1570**')).toBe(0);
  });

  it('counts only the spoken words', () => {
    expect(countWords('Hello [PAUSE] world.')).toBe(2);
    expect(countWords('**Bold** and *italic* words.[1]')).toBe(4);
  });
});

describe('splitScriptIntoSections — drops metadata-only sections', () => {
  it('does not surface a section whose only content is the closing TOTAL line', () => {
    const script = `## Intro

This is the intro paragraph. It has plenty of words to clear the minimum threshold for a section. We talk about the topic and tease what's coming. We then circle back to the hook with a final teaser line that the narrator will read aloud. We then circle back to the hook with a final teaser line that the narrator will read aloud.

## Body

Here is the meat of the script with enough words to count as a real section in the splitter and not get merged into adjacent ones. We continue with another paragraph that adds substance and additional examples for the narrator to deliver. We continue with another paragraph that adds substance and additional examples for the narrator to deliver.

## Outro

**TOTAL SPOKEN WORD COUNT: 1570** (Opening 28 + Intro 84 + Main 1045 + Outro 118 = 1498. Verified.)`;

    const sections = splitScriptIntoSections(script, 150);
    // The Outro section is metadata-only — it should be dropped, not
    // surfaced as an empty card to the narrator.
    expect(sections.find(s => s.label === 'Outro')).toBeUndefined();
    // The two real sections survive.
    expect(sections.length).toBeGreaterThanOrEqual(1);
    expect(sections.every(s => countWords(s.script_text) > 0)).toBe(true);
  });
});

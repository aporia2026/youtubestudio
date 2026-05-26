import { describe, expect, it } from 'vitest';
import { extractScriptTitles, looksLikePlainTextHeading } from '@/lib/script-titles';

// ---------------------------------------------------------------------------
// Heuristic unit tests — context-aware plain-text title detection.
// ---------------------------------------------------------------------------

describe('looksLikePlainTextHeading — positive cases', () => {
  it('detects "Dyatlov Pass" with blank line above and prose below', () => {
    expect(
      looksLikePlainTextHeading(
        'Dyatlov Pass',
        '',
        'In February 1959, nine hikers died in the Ural Mountains.',
      ),
    ).toBe(true);
  });

  it('detects "The Wow! Signal" — internal punctuation is fine, only trailing matters', () => {
    expect(
      looksLikePlainTextHeading(
        'The Wow! Signal',
        '',
        'In 1977, a radio telescope in Ohio detected a narrowband signal.',
      ),
    ).toBe(true);
  });

  it('detects "The Mary Celeste" — stopwords don\'t break title-case check', () => {
    expect(
      looksLikePlainTextHeading(
        'The Mary Celeste',
        '',
        'In 1872, the Mary Celeste was found adrift in the Atlantic.',
      ),
    ).toBe(true);
  });

  it('detects all-caps headings like "WANNACRY"', () => {
    expect(
      looksLikePlainTextHeading(
        'WANNACRY',
        '',
        'The May 2017 ransomware outbreak crippled hospitals across the UK.',
      ),
    ).toBe(true);
  });

  it('detects "UVB-76" — alphanumeric all-caps', () => {
    expect(
      looksLikePlainTextHeading(
        'UVB-76',
        '',
        'Since the late 1970s, a shortwave radio station has broadcast a continuous tone.',
      ),
    ).toBe(true);
  });

  it('detects when the line above is null (start of file)', () => {
    expect(
      looksLikePlainTextHeading(
        'The Antikythera Mechanism',
        null,
        'Recovered from a shipwreck in 1901. A Hellenistic analog computer.',
      ),
    ).toBe(true);
  });
});

describe('looksLikePlainTextHeading — negative cases', () => {
  it('rejects lines ending in a period', () => {
    expect(
      looksLikePlainTextHeading(
        'It never repeated.',
        '',
        'That isolated nature defines the event entirely.',
      ),
    ).toBe(false);
  });

  it('rejects lines ending in a comma', () => {
    expect(
      looksLikePlainTextHeading(
        'Whatever the sequence,',
        '',
        'the evidence deviates from standard high-altitude fatality models.',
      ),
    ).toBe(false);
  });

  it('rejects lines following adjacent prose (no blank line above)', () => {
    expect(
      looksLikePlainTextHeading(
        'The Verdict',
        'And so the inquiry closed.',
        'No conclusive cause was ever established by the investigators.',
      ),
    ).toBe(false);
  });

  it('rejects when the line below is too short to be a section body', () => {
    expect(
      looksLikePlainTextHeading(
        'The End',
        '',
        'Right?', // too short
      ),
    ).toBe(false);
  });

  it('rejects sentence-case lines that lack title casing', () => {
    expect(
      looksLikePlainTextHeading(
        'he looked at the map',
        '',
        'Then he started walking through the dense underbrush silently.',
      ),
    ).toBe(false);
  });

  it('rejects lines that exceed the 60-char ceiling', () => {
    const long = 'A Very Long And Verbose Title That Goes On For Quite Some Time Indeed';
    expect(long.length).toBeGreaterThan(60);
    expect(
      looksLikePlainTextHeading(
        long,
        '',
        'And then the story begins in earnest with the first true sentence.',
      ),
    ).toBe(false);
  });

  it('rejects empty / whitespace-only lines', () => {
    expect(
      looksLikePlainTextHeading('   ', '', 'Some prose here.'),
    ).toBe(false);
  });

  it('rejects when the line below is null (end of file)', () => {
    expect(
      looksLikePlainTextHeading('Final Section', '', null),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests against the full extractScriptTitles pipeline using a
// snippet of the user's actual script (Dyatlov Pass / Wow! Signal / Mary
// Celeste). Catches regressions in the end-to-end stripping behavior.
// ---------------------------------------------------------------------------

const SAMPLE_SCRIPT = `Dyatlov Pass
In February 1959, nine hikers died in the Ural Mountains at Dyatlov Pass. Their tent was found cut open from the inside. Several bodies sustained severe trauma.
Modern consensus points to a slab avalanche, though the exact sequence is still disputed.

The Wow! Signal
In 1977, a radio telescope in Ohio detected a narrowband signal from deep space. It lasted 72 seconds.
It never repeated. That isolated nature defines the event.

The Mary Celeste
In 1872, the Mary Celeste was found adrift in the Atlantic. No crew. Cargo mostly intact.
Storm damage, panic, piracy, or alcohol fumes have all been modeled. None perfectly fit the scene.`;

describe('extractScriptTitles — plain-text headings end-to-end', () => {
  it('extracts all three section titles from the sample script', () => {
    const out = extractScriptTitles(SAMPLE_SCRIPT);
    expect(out.titles.map(t => t.text)).toEqual([
      'Dyatlov Pass',
      'The Wow! Signal',
      'The Mary Celeste',
    ]);
  });

  it('replaces heading lines with sentinels in the stripped script', () => {
    const out = extractScriptTitles(SAMPLE_SCRIPT);
    expect(out.stripped).toContain('<<TITLE_0>>');
    expect(out.stripped).toContain('<<TITLE_1>>');
    expect(out.stripped).toContain('<<TITLE_2>>');
    // The original heading text is NOT in the stripped output (only the sentinel)
    expect(out.stripped.startsWith('<<TITLE_0>>')).toBe(true);
  });

  it('emits a warning recommending the `##` prefix when heuristic fires', () => {
    const out = extractScriptTitles(SAMPLE_SCRIPT);
    expect(out.warnings.some(w => w.includes('plain-text heading'))).toBe(true);
  });

  it('explicit `##` prefix still works and does not double-extract via heuristic', () => {
    const explicit = `## Dyatlov Pass\nBody paragraph one is here.\n\n## The Wow! Signal\nBody paragraph two is here as well.`;
    const out = extractScriptTitles(explicit);
    expect(out.titles.map(t => t.text)).toEqual(['Dyatlov Pass', 'The Wow! Signal']);
    // No "plain-text heading" warning when explicit ## is used.
    expect(out.warnings.some(w => w.includes('plain-text heading'))).toBe(false);
  });

  it('does not falsely detect mid-paragraph short lines as titles', () => {
    const tricky = `The villagers gathered at dawn.
Old Man Henderson stood up.
He spoke first.

Then everything changed.`;
    const out = extractScriptTitles(tricky);
    // None of these should be detected as titles (all sentence-case, periods)
    expect(out.titles).toEqual([]);
  });

  it('does not detect content inside fenced code blocks', () => {
    const withFence = '```\nDyatlov Pass\nNot a heading inside code.\n```';
    const out = extractScriptTitles(withFence);
    expect(out.titles).toEqual([]);
  });
});

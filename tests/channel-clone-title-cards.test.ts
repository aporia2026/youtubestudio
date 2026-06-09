/**
 * Tests for the channel-clone Title Card mechanism wired into
 * `src/lib/channel-clone/rowify-runner.ts` on 2026-06-07.
 *
 * The runner now:
 *   1. Extracts `## Heading` lines from the approved script into
 *      `<<TITLE_N>>` sentinels before the LLM sees the text.
 *   2. Asks the LLM to emit one Title Card row per sentinel.
 *   3. Demotes mistagged Title Cards and synthesizes dropped ones via
 *      `normalizeTitleCards`.
 *
 * These tests exercise the building blocks the runner composes:
 *   - The parser now accepts `'Title Card'` as a valid visual_type
 *     and skips the ai_image-prompt non-emptiness check for it.
 *   - `computeCoverageFraction` ignores Title Card rows on both sides
 *     (the reference script has its heading lines stripped before
 *     comparison, and the row list filters them out).
 *   - The normalize pass works end-to-end against channel-clone-shape
 *     rows: it inserts dropped titles + demotes mistagged ones.
 *
 * The LLM-bound `runRowify` call itself is integration-tested elsewhere.
 */

import { describe, expect, it } from 'vitest';
import {
  computeCoverageFraction,
  parseRowifyResponse,
  type ChannelCloneProductionRow,
} from '@/lib/channel-clone/rowify-runner';
import type { ProductionDocRowLike } from '@/lib/production-doc-postprocess';
import { extractScriptTitles } from '@/lib/script-titles';
import { normalizeTitleCards } from '@/lib/title-card-repair';

// ─── parseRowifyResponse — Title Card branch ──────────────────────

describe('parseRowifyResponse — Title Card rows', () => {
  it('accepts a Title Card row with empty ai_image_prompt + stock_search_terms', () => {
    const payload = {
      rows: [
        {
          timecode: '0:00-0:04',
          script_text: 'Knight Capital',
          visual_type: 'Title Card',
          visual_description: 'Title card displaying "Knight Capital"',
          stock_search_terms: '',
          ai_image_prompt: '',
          on_screen_text: 'Knight Capital',
          notes: 'Act break.',
        },
      ],
    };
    const out = parseRowifyResponse(JSON.stringify(payload));
    expect(out).toHaveLength(1);
    expect(out[0].visual_type).toBe('Title Card');
    expect(out[0].ai_image_prompt).toBe('');
  });

  it('keeps an ai_image row with empty ai_image_prompt (lenient parser keeps the row, image-gen surface handles the empty case)', () => {
    // 2026-06-10: rowify parser was rewritten to be tolerant.
    // Authoritative coverage in tests/channel-clone-rowify-tolerance.test.ts.
    const payload = {
      rows: [
        {
          timecode: '0:00-0:04',
          script_text: 'Opening narration.',
          visual_type: 'ai_image',
          visual_description: 'A doodle figure waves.',
          stock_search_terms: '',
          ai_image_prompt: '',
          on_screen_text: '',
          notes: '',
        },
      ],
    };
    const out = parseRowifyResponse(JSON.stringify(payload));
    expect(out).toHaveLength(1);
    expect(out[0].visual_type).toBe('ai_image');
    // Empty ai_image_prompt is filled from visual_description so the
    // image-gen pipeline always has something to render.
    expect(out[0].ai_image_prompt).toBe('A doodle figure waves.');
  });

  it('normalizes "TitleCard" (no space) to "Title Card" instead of rejecting it', () => {
    // Models frequently emit visual_type variants without exact
    // capitalisation / spacing. The normaliser strips non-letters and
    // matches case-insensitively, so 'TitleCard' -> 'titlecard' ->
    // canonical 'Title Card'.
    const payload = {
      rows: [
        {
          timecode: '0:00-0:04',
          script_text: 'Some text.',
          visual_type: 'TitleCard',
          visual_description: '',
          stock_search_terms: '',
          ai_image_prompt: '',
          on_screen_text: '',
          notes: '',
        },
      ],
    };
    const out = parseRowifyResponse(JSON.stringify(payload));
    expect(out).toHaveLength(1);
    expect(out[0].visual_type).toBe('Title Card');
  });
});

// ─── computeCoverageFraction — Title Card exclusion ───────────────

describe('computeCoverageFraction — Title Card rows excluded', () => {
  const narrationRow = (script_text: string): ChannelCloneProductionRow => ({
    timecode: '0:00-0:04',
    script_text,
    visual_type: 'ai_image',
    visual_description: 'A scene.',
    stock_search_terms: '',
    ai_image_prompt: 'A scene.',
    on_screen_text: '',
    notes: '',
  });
  const titleRow = (text: string): ChannelCloneProductionRow => ({
    timecode: '0:00-0:04',
    script_text: text,
    visual_type: 'Title Card',
    visual_description: `Title card displaying "${text}"`,
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: text,
    notes: '',
  });

  it('reports 100% coverage when narration rows reproduce the script', () => {
    const script = 'Right now, you are the only creature that cries.';
    const rows = [narrationRow(script)];
    expect(computeCoverageFraction(rows, script)).toBe(1);
  });

  it('ignores Title Card rows in the numerator', () => {
    const script = 'Right now, you are the only creature that cries.';
    const rows = [titleRow('Crying'), narrationRow(script)];
    // Adding a Title Card shouldn't push coverage past 1.0 or change it.
    expect(computeCoverageFraction(rows, script)).toBe(1);
  });

  it('strips `## Heading` lines from the reference script before comparing', () => {
    // Without the strip, the script's "## Crying" line would inflate
    // the denominator and the row text would only cover ~70% of it,
    // even though the narration covers 100% of the actual prose.
    const script = '## Crying\n\nRight now, you are the only creature that cries.';
    const rows = [titleRow('Crying'), narrationRow('Right now, you are the only creature that cries.')];
    expect(computeCoverageFraction(rows, script)).toBe(1);
  });
});

// ─── End-to-end: extract + normalize round-trip ───────────────────

describe('channel-clone rowify pipeline — extract + normalize round-trip', () => {
  function makeRow(over: Partial<ChannelCloneProductionRow>): ChannelCloneProductionRow {
    return {
      timecode: '0:00-0:04',
      script_text: '',
      visual_type: 'ai_image',
      visual_description: '',
      stock_search_terms: '',
      ai_image_prompt: 'something',
      on_screen_text: '',
      notes: '',
      ...over,
    };
  }

  it('extractScriptTitles finds `## Heading` lines and replaces them with sentinels', () => {
    const script = [
      'Opening hook line.',
      '',
      '## Act One',
      '',
      'And then everything changes.',
      '',
      '## Act Two',
      '',
      'But the bigger shock comes here.',
    ].join('\n');
    const { titles, stripped } = extractScriptTitles(script);
    expect(titles.map((t) => t.text)).toEqual(['Act One', 'Act Two']);
    expect(titles[0].sentinel).toBe('<<TITLE_0>>');
    expect(titles[1].sentinel).toBe('<<TITLE_1>>');
    expect(stripped).toContain('<<TITLE_0>>');
    expect(stripped).toContain('<<TITLE_1>>');
    expect(stripped).not.toContain('## Act One');
  });

  it('normalize inserts a Title Card the LLM dropped at the right position', () => {
    // LLM emitted no Title Card rows; the repair should add one at
    // the position the sentinel sits in the stripped script.
    const script = [
      'First part of the script.',
      '',
      '## Section B',
      '',
      'Second part of the script.',
    ].join('\n');
    const { titles, stripped } = extractScriptTitles(script);

    const llmRows: ChannelCloneProductionRow[] = [
      makeRow({ script_text: 'First part of the script.' }),
      makeRow({ script_text: 'Second part of the script.' }),
    ];

    const out = normalizeTitleCards(llmRows as unknown as ProductionDocRowLike[], titles, stripped, { allowOverlay: false });
    expect(out.insertedCount).toBe(1);
    expect(out.insertedTitles).toEqual(['Section B']);
    expect(out.rows).toHaveLength(3);
    // The new Title Card sits between the two narration rows.
    expect(out.rows[0].visual_type).toBe('ai_image');
    expect(out.rows[1].visual_type).toBe('Title Card');
    expect(out.rows[1].script_text).toBe('Section B');
    expect(out.rows[2].visual_type).toBe('ai_image');
  });

  it('normalize demotes an LLM-mistagged Title Card to Animation when text does not match any extracted heading', () => {
    const script = ['Narration A.', '', '## Real Heading', '', 'Narration B.'].join('\n');
    const { titles, stripped } = extractScriptTitles(script);

    // LLM emitted the real heading correctly AND a bogus extra Title
    // Card for a line that's actually narration. The bogus row gets
    // demoted; the real heading stays.
    const llmRows: ChannelCloneProductionRow[] = [
      makeRow({ script_text: 'Narration A.' }),
      makeRow({
        script_text: 'Narration B.',
        visual_type: 'Title Card', // bogus tag
        visual_description: 'Title card displaying "Narration B."',
        ai_image_prompt: '',
        on_screen_text: 'Narration B.',
      }),
      makeRow({
        script_text: 'Real Heading',
        visual_type: 'Title Card',
        visual_description: 'Title card displaying "Real Heading"',
        ai_image_prompt: '',
        on_screen_text: 'Real Heading',
      }),
    ];

    const out = normalizeTitleCards(llmRows as unknown as ProductionDocRowLike[], titles, stripped, { allowOverlay: false });
    expect(out.demotedCount).toBe(1);
    expect(out.demotedSamples).toEqual(['Narration B.']);
    // The demoted row's visual_type is the main pipeline's 'Animation';
    // the runner downstream maps that back to 'ai_image' before
    // returning. We assert on what normalize emitted directly here.
    const demotedRow = out.rows.find((r) => r.script_text === 'Narration B.');
    expect(demotedRow?.visual_type).toBe('Animation');
    // The real heading row survives.
    const realHeading = out.rows.find((r) => r.script_text === 'Real Heading');
    expect(realHeading?.visual_type).toBe('Title Card');
  });

  it('round-trip with no headings is a no-op', () => {
    const script = 'Just one continuous block of narration here.';
    const { titles, stripped } = extractScriptTitles(script);
    expect(titles).toHaveLength(0);
    const llmRows: ChannelCloneProductionRow[] = [makeRow({ script_text: script })];
    const out = normalizeTitleCards(llmRows as unknown as ProductionDocRowLike[], titles, stripped, { allowOverlay: false });
    expect(out.insertedCount).toBe(0);
    expect(out.demotedCount).toBe(0);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].visual_type).toBe('ai_image');
  });
});

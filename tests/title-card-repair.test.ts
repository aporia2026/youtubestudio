import { describe, expect, it } from 'vitest';
import { repairMissingTitleCards } from '@/lib/title-card-repair';
import { extractScriptTitles, type ExtractedTitle } from '@/lib/script-titles';
import type { ProductionDocRowLike } from '@/lib/production-doc-postprocess';

// Covers the contract documented in
// `_plans/2026-06-03-title-card-deterministic-repair.md`: every detected
// title must end up as a Title Card row in the saved doc, regardless of
// what the LLM emitted.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tc = (text: string, timecode = '00:30'): ProductionDocRowLike => ({
  timecode,
  script_text: text,
  visual_type: 'Title Card',
  visual_description: `Title card displaying "${text}"`,
  stock_search_terms: '',
  ai_image_prompt: '',
  on_screen_text: text,
  notes: '',
});

const narration = (text: string, timecode = '00:35'): ProductionDocRowLike => ({
  timecode,
  script_text: text,
  visual_type: 'Animation',
  visual_description: 'A cinematic wide shot.',
  stock_search_terms: 'keyword',
  ai_image_prompt: 'A wide shot of a city street at dusk.',
  on_screen_text: '',
  notes: '',
});

const opts = { allowOverlay: false };
const optsOverlay = { allowOverlay: true };

/** Construct an `ExtractedTitle` whose sentinel sits at a known offset
 *  inside a hand-built stripped script. Real callers (the route) get this
 *  shape from `extractScriptTitles`; tests build it directly so the
 *  sentinel positions and row script_text snippets line up clearly. */
const titleFor = (i: number, text: string): ExtractedTitle => ({
  text,
  sentinel: `<<TITLE_${i}>>`,
  originalLine: `## ${text}`,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('repairMissingTitleCards', () => {
  it('returns rows unchanged when every expected title was emitted in order', () => {
    const titles = [titleFor(0, 'One'), titleFor(1, 'Two'), titleFor(2, 'Three')];
    const stripped = [
      '<<TITLE_0>>',
      'Body of one.',
      '<<TITLE_1>>',
      'Body of two.',
      '<<TITLE_2>>',
      'Body of three.',
    ].join('\n');
    const rows = [
      tc('One'),
      narration('Body of one.'),
      tc('Two'),
      narration('Body of two.'),
      tc('Three'),
      narration('Body of three.'),
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(0);
    expect(result.insertedTitles).toEqual([]);
    expect(result.rows).toEqual(rows);
  });

  it('inserts a missing middle title at the correct position', () => {
    const titles = [titleFor(0, 'One'), titleFor(1, 'Two'), titleFor(2, 'Three')];
    const stripped = [
      '<<TITLE_0>>',
      'Body of one.',
      '<<TITLE_1>>',
      'Body of two.',
      '<<TITLE_2>>',
      'Body of three.',
    ].join('\n');
    const rows = [
      tc('One'),
      narration('Body of one.'),
      narration('Body of two.'), // Title Card for "Two" missing
      tc('Three'),
      narration('Body of three.'),
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(1);
    expect(result.insertedTitles).toEqual(['Two']);
    expect(result.rows.map((r) => r.visual_type)).toEqual([
      'Title Card', // One
      'Animation',  // Body of one.
      'Title Card', // Two (synthesized, inserted before "Body of two.")
      'Animation',  // Body of two.
      'Title Card', // Three
      'Animation',  // Body of three.
    ]);
    expect(result.rows[2].script_text).toBe('Two');
    expect(result.rows[2].on_screen_text).toBe('Two');
  });

  it('inserts a missing first title at the sentinel position (after a pre-title hook)', () => {
    // Script shape: hook narration → ##Intro → intro body → ##Body → body body.
    // LLM dropped the "Intro" Title Card. Synthesized Intro must land
    // BETWEEN the hook narration and the intro body — that's where the
    // sentinel <<TITLE_0>> sits in the stripped script.
    const titles = [titleFor(0, 'Intro'), titleFor(1, 'Body')];
    const stripped = [
      'Hook line opening the video.',
      '<<TITLE_0>>',
      'Intro body content here.',
      '<<TITLE_1>>',
      'Body content here.',
    ].join('\n');
    const rows = [
      narration('Hook line opening the video.'),
      narration('Intro body content here.'),
      tc('Body'),
      narration('Body content here.'),
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(1);
    expect(result.insertedTitles).toEqual(['Intro']);
    expect(result.rows.map((r) => r.visual_type)).toEqual([
      'Animation',  // Hook narration (came before <<TITLE_0>>)
      'Title Card', // Intro synthesized at sentinel position
      'Animation',  // Intro body
      'Title Card', // Body
      'Animation',  // Body content
    ]);
    expect(result.rows[1].script_text).toBe('Intro');
  });

  it('inserts a missing first title at index 0 when the script opens with the sentinel', () => {
    const titles = [titleFor(0, 'Opener'), titleFor(1, 'Next')];
    const stripped = [
      '<<TITLE_0>>',
      'Opener narration.',
      '<<TITLE_1>>',
      'Next narration.',
    ].join('\n');
    const rows = [
      narration('Opener narration.'),
      tc('Next'),
      narration('Next narration.'),
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(1);
    expect(result.insertedTitles).toEqual(['Opener']);
    expect(result.rows[0].visual_type).toBe('Title Card');
    expect(result.rows[0].script_text).toBe('Opener');
  });

  it('appends a missing final title at the end', () => {
    const titles = [titleFor(0, 'One'), titleFor(1, 'Two'), titleFor(2, 'Outro')];
    const stripped = [
      '<<TITLE_0>>',
      'Body of one.',
      '<<TITLE_1>>',
      'Body of two.',
      '<<TITLE_2>>',
      'Outro narration.',
    ].join('\n');
    const rows = [
      tc('One'),
      narration('Body of one.'),
      tc('Two'),
      narration('Body of two.'),
      // Title Card for "Outro" missing, AND its narration was dropped too
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(1);
    expect(result.insertedTitles).toEqual(['Outro']);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[4].visual_type).toBe('Title Card');
    expect(result.rows[4].script_text).toBe('Outro');
  });

  it('inserts two consecutive missing titles in script order at their sentinel positions', () => {
    const titles = [titleFor(0, 'One'), titleFor(1, 'Two'), titleFor(2, 'Three')];
    const stripped = [
      '<<TITLE_0>>',
      'Body of one.',
      '<<TITLE_1>>',
      'Body of two.',
      '<<TITLE_2>>',
      'Body of three.',
    ].join('\n');
    const rows = [
      tc('One'),
      narration('Body of one.'),
      narration('Body of two.'),   // Title Card for "Two" missing
      narration('Body of three.'), // Title Card for "Three" missing
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(2);
    expect(result.insertedTitles).toEqual(['Two', 'Three']);
    expect(result.rows.map((r) => r.visual_type)).toEqual([
      'Title Card', // One
      'Animation',  // Body of one
      'Title Card', // Two (synthesized, before Body of two)
      'Animation',  // Body of two
      'Title Card', // Three (synthesized, before Body of three)
      'Animation',  // Body of three
    ]);
    expect(result.rows[2].script_text).toBe('Two');
    expect(result.rows[4].script_text).toBe('Three');
  });

  it('handles empty expectedTitles as a no-op', () => {
    const rows = [narration('a'), narration('b')];
    const result = repairMissingTitleCards(rows, [], 'a\nb', opts);
    expect(result.insertedCount).toBe(0);
    expect(result.rows).toEqual(rows);
  });

  it('inserts every title when rows is empty', () => {
    const titles = [titleFor(0, 'A'), titleFor(1, 'B')];
    const stripped = '<<TITLE_0>>\n<<TITLE_1>>';
    const result = repairMissingTitleCards<ProductionDocRowLike>([], titles, stripped, opts);
    expect(result.insertedCount).toBe(2);
    expect(result.insertedTitles).toEqual(['A', 'B']);
    expect(result.rows.map((r) => r.script_text)).toEqual(['A', 'B']);
    expect(result.rows.every((r) => r.visual_type === 'Title Card')).toBe(true);
  });

  it('matches title text with punctuation tolerance', () => {
    const titles = [titleFor(0, 'Knight Capital'), titleFor(1, 'The End')];
    const stripped = '<<TITLE_0>>\nBody one.\n<<TITLE_1>>\nBody two.';
    const rows = [
      tc('Knight Capital.'), // LLM added a trailing period
      narration('Body one.'),
      tc('the end'),         // LLM lowercased
      narration('Body two.'),
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(0);
  });

  it('matches title text with whitespace tolerance', () => {
    const titles = [titleFor(0, 'The Big Reveal')];
    const stripped = '<<TITLE_0>>\nBody.';
    const rows = [
      { ...tc('  The   Big   Reveal  ') },
      narration('Body.'),
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(0);
  });

  it('omits overlay_* fields when allowOverlay is false', () => {
    const titles = [titleFor(0, 'Solo')];
    const stripped = '<<TITLE_0>>\nBody.';
    const result = repairMissingTitleCards<ProductionDocRowLike>([], titles, stripped, opts);
    const row = result.rows[0];
    expect(row).not.toHaveProperty('overlay_stock_terms');
    expect(row).not.toHaveProperty('overlay_zone');
    expect(row).not.toHaveProperty('overlay_size');
  });

  it('includes overlay_* fields when allowOverlay is true', () => {
    const titles = [titleFor(0, 'Solo')];
    const stripped = '<<TITLE_0>>\nBody.';
    const result = repairMissingTitleCards<ProductionDocRowLike>([], titles, stripped, optsOverlay);
    const row = result.rows[0];
    expect(row).toHaveProperty('overlay_stock_terms', '');
    expect(row).toHaveProperty('overlay_zone', '');
    expect(row).toHaveProperty('overlay_size', '');
  });

  it('synthetic row carries the expected Title Card shape', () => {
    const titles = [titleFor(0, 'Chapter 1')];
    const stripped = '<<TITLE_0>>\nBody.';
    const result = repairMissingTitleCards<ProductionDocRowLike>([], titles, stripped, opts);
    const row = result.rows[0];
    expect(row.visual_type).toBe('Title Card');
    expect(row.script_text).toBe('Chapter 1');
    expect(row.ai_image_prompt).toBe('');
    expect(row.stock_search_terms).toBe('');
    expect(row.on_screen_text).toBe('Chapter 1');
    expect(row.visual_description).toBe('Title card displaying "Chapter 1"');
    // No prior emitted row, so timecode falls back to the doc start.
    expect(row.timecode).toBe('00:00');
  });

  it('reuses the previous emitted row timecode as placeholder for mid-doc inserts', () => {
    const titles = [titleFor(0, 'One'), titleFor(1, 'Two')];
    const stripped = [
      '<<TITLE_0>>',
      'Body of one.',
      '<<TITLE_1>>',
      'Body of two.',
    ].join('\n');
    const rows = [
      tc('One', '00:10'),
      narration('Body of one.', '00:14'),
      narration('Body of two.', '00:30'), // Title Card "Two" missing
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(1);
    // Synthetic "Two" lands between rows[1] and rows[2]; its timecode is
    // the previous emitted row's value ("Body of one." at 00:14).
    expect(result.rows[2].timecode).toBe('00:14');
  });

  it('preserves non-row fields passed through on existing rows', () => {
    // Generic-type extension: repairMissingTitleCards must not strip
    // extra fields the route adds (group_id, character_id, etc.).
    interface ExtendedRow extends ProductionDocRowLike {
      group_id?: string;
      character_id?: string;
    }
    const titles = [titleFor(0, 'One'), titleFor(1, 'Two')];
    const stripped = [
      '<<TITLE_0>>',
      'Body of one.',
      '<<TITLE_1>>',
      'Body of two.',
    ].join('\n');
    const rows: ExtendedRow[] = [
      { ...tc('One'), group_id: 'g1' } as ExtendedRow,
      { ...narration('Body of one.'), character_id: 'host' } as ExtendedRow,
      { ...narration('Body of two.'), character_id: 'host' } as ExtendedRow,
    ];
    const result = repairMissingTitleCards(rows, titles, stripped, opts);
    expect(result.insertedCount).toBe(1);
    expect((result.rows[0] as ExtendedRow).group_id).toBe('g1');
    expect((result.rows[1] as ExtendedRow).character_id).toBe('host');
    // Synthetic "Two" sits at index 2 (between rows[1] and rows[2]),
    // so the original rows[2] is now at index 3 with its host tag intact.
    expect(result.rows[2].visual_type).toBe('Title Card');
    expect((result.rows[3] as ExtendedRow).character_id).toBe('host');
  });

  it('integrates with extractScriptTitles output end-to-end', () => {
    // Build the stripped + titles via the real extractor so we test the
    // exact data shape the route hands to the repair function.
    const script = [
      'Hook narration.',
      '',
      '## Alpha',
      'Body alpha here.',
      '',
      '## Beta',
      'Body beta here.',
      '',
      '## Gamma',
      'Body gamma here.',
    ].join('\n');
    const extracted = extractScriptTitles(script);
    expect(extracted.titles.map((t) => t.text)).toEqual(['Alpha', 'Beta', 'Gamma']);

    // LLM emitted only Alpha and Gamma; Beta missing.
    const rows = [
      narration('Hook narration.'),
      tc('Alpha'),
      narration('Body alpha here.'),
      narration('Body beta here.'),
      tc('Gamma'),
      narration('Body gamma here.'),
    ];
    const result = repairMissingTitleCards(rows, extracted.titles, extracted.stripped, opts);
    expect(result.insertedCount).toBe(1);
    expect(result.insertedTitles).toEqual(['Beta']);
    // Beta should land between "Body alpha" and "Body beta".
    const visualTypes = result.rows.map((r) => r.visual_type);
    expect(visualTypes).toEqual([
      'Animation',  // Hook
      'Title Card', // Alpha
      'Animation',  // Body alpha
      'Title Card', // Beta (synthesized)
      'Animation',  // Body beta
      'Title Card', // Gamma
      'Animation',  // Body gamma
    ]);
    expect(result.rows[3].script_text).toBe('Beta');
  });
});

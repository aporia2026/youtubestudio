/**
 * Tests for the editor "Fill blanks" work-unit chunker.
 *
 * Pins the chunking rules so a future refactor of `runFillBlanks`
 * surfaces any behavior change in a failing test instead of a silent
 * "wait, why did my variants come out wrong" moment.
 */

import { describe, expect, it } from 'vitest';
import { buildFillBlanksUnits } from '@/lib/editor/fill-blanks-units';
import type { ProductionDoc } from '@/remotion/utils';

type Row = ProductionDoc['rows'][number];

function row(fields: Partial<Row> = {}): Row {
  return {
    timecode: '0:00',
    script_text: '',
    visual_type: 'Animation',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    ...fields,
  };
}

describe('buildFillBlanksUnits — collage off', () => {
  it('emits one single unit per blank in order', () => {
    const rows = [row(), row(), row()];
    const units = buildFillBlanksUnits({
      blankIndices: [0, 1, 2],
      rows,
      collageOn: false,
      docModelDefault: undefined,
    });
    expect(units).toEqual([
      { kind: 'single', index: 0 },
      { kind: 'single', index: 1 },
      { kind: 'single', index: 2 },
    ]);
  });

  it('preserves the blank-list order, not the row order', () => {
    const rows = [row(), row(), row(), row()];
    const units = buildFillBlanksUnits({
      blankIndices: [3, 0, 2],
      rows,
      collageOn: false,
      docModelDefault: undefined,
    });
    expect(units.map((u) => (u.kind === 'single' ? u.index : -1))).toEqual([3, 0, 2]);
  });

  it('emits nothing when there are no blanks', () => {
    expect(
      buildFillBlanksUnits({
        blankIndices: [],
        rows: [row()],
        collageOn: false,
        docModelDefault: undefined,
      }),
    ).toEqual([]);
  });
});

describe('buildFillBlanksUnits — collage on', () => {
  it('groups 4 consecutive non-variant blanks into one collage unit', () => {
    const rows = [row(), row(), row(), row()];
    const units = buildFillBlanksUnits({
      blankIndices: [0, 1, 2, 3],
      rows,
      collageOn: true,
      docModelDefault: undefined,
    });
    expect(units).toEqual([{ kind: 'collage', indices: [0, 1, 2, 3] }]);
  });

  it('leaves a trailing run shorter than 4 as singles', () => {
    const rows = [row(), row(), row(), row(), row(), row()];
    const units = buildFillBlanksUnits({
      blankIndices: [0, 1, 2, 3, 4, 5],
      rows,
      collageOn: true,
      docModelDefault: undefined,
    });
    expect(units).toEqual([
      { kind: 'collage', indices: [0, 1, 2, 3] },
      { kind: 'single', index: 4 },
      { kind: 'single', index: 5 },
    ]);
  });

  it('breaks the chunk when a row has a differing image_model override', () => {
    const rows = [
      row(),
      row({ image_model: 'kie-flux' }), // doesn't match docModelDefault
      row(),
      row(),
      row(),
    ];
    const units = buildFillBlanksUnits({
      blankIndices: [0, 1, 2, 3, 4],
      rows,
      collageOn: true,
      docModelDefault: 'atlas',
    });
    // Row 0 -> single (chunk broken by row 1).
    // Row 1 -> single (override).
    // Rows 2-5 would be a chunk but there's only 3 left -> all singles.
    expect(units).toEqual([
      { kind: 'single', index: 0 },
      { kind: 'single', index: 1 },
      { kind: 'single', index: 2 },
      { kind: 'single', index: 3 },
      { kind: 'single', index: 4 },
    ]);
  });

  it('a row whose image_model matches docModelDefault stays in the chunk', () => {
    const rows = [
      row({ image_model: 'atlas' }),
      row({ image_model: 'atlas' }),
      row({ image_model: 'atlas' }),
      row({ image_model: 'atlas' }),
    ];
    const units = buildFillBlanksUnits({
      blankIndices: [0, 1, 2, 3],
      rows,
      collageOn: true,
      docModelDefault: 'atlas',
    });
    expect(units).toEqual([{ kind: 'collage', indices: [0, 1, 2, 3] }]);
  });

  it('always emits variant rows as singles, even when 4 are consecutive', () => {
    const rows = [
      row({ variant_index: 1, group_id: 'g1' }),
      row({ variant_index: 1, group_id: 'g2' }),
      row({ variant_index: 1, group_id: 'g3' }),
      row({ variant_index: 1, group_id: 'g4' }),
    ];
    const units = buildFillBlanksUnits({
      blankIndices: [0, 1, 2, 3],
      rows,
      collageOn: true,
      docModelDefault: undefined,
    });
    expect(units).toEqual([
      { kind: 'single', index: 0 },
      { kind: 'single', index: 1 },
      { kind: 'single', index: 2 },
      { kind: 'single', index: 3 },
    ]);
  });

  it('breaks the chunk when a variant row appears mid-run', () => {
    const rows = [
      row(),
      row(),
      row({ variant_index: 1, group_id: 'g1' }), // breaks the chunk
      row(),
      row(),
      row(),
    ];
    const units = buildFillBlanksUnits({
      blankIndices: [0, 1, 2, 3, 4, 5],
      rows,
      collageOn: true,
      docModelDefault: undefined,
    });
    // Rows 0,1 -> singles (chunk broken by row 2).
    // Row 2 -> single (variant).
    // Rows 3,4,5 -> singles (only 3 left, can't fill a chunk).
    expect(units).toEqual([
      { kind: 'single', index: 0 },
      { kind: 'single', index: 1 },
      { kind: 'single', index: 2 },
      { kind: 'single', index: 3 },
      { kind: 'single', index: 4 },
      { kind: 'single', index: 5 },
    ]);
  });

  it('treats variant_index 0 as a base row (eligible for collage)', () => {
    const rows = [
      row({ variant_index: 0, group_id: 'g1' }),
      row({ variant_index: 0, group_id: 'g2' }),
      row({ variant_index: 0, group_id: 'g3' }),
      row({ variant_index: 0, group_id: 'g4' }),
    ];
    const units = buildFillBlanksUnits({
      blankIndices: [0, 1, 2, 3],
      rows,
      collageOn: true,
      docModelDefault: undefined,
    });
    expect(units).toEqual([{ kind: 'collage', indices: [0, 1, 2, 3] }]);
  });

  it('handles a long mixed sequence', () => {
    const rows = [
      row(), // 0 base
      row(), // 1 base
      row(), // 2 base
      row(), // 3 base
      row(), // 4 base
      row({ variant_index: 1, group_id: 'g' }), // 5 variant
      row({ variant_index: 2, group_id: 'g' }), // 6 variant
      row(), // 7 base
      row(), // 8 base
      row(), // 9 base
      row(), // 10 base
    ];
    const units = buildFillBlanksUnits({
      blankIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      rows,
      collageOn: true,
      docModelDefault: undefined,
    });
    expect(units).toEqual([
      { kind: 'collage', indices: [0, 1, 2, 3] },
      { kind: 'single', index: 4 },
      { kind: 'single', index: 5 },
      { kind: 'single', index: 6 },
      { kind: 'collage', indices: [7, 8, 9, 10] },
    ]);
  });
});

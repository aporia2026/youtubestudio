/**
 * Unit tests for `computeAffectedRows` + <FlipOstToOverlayModal>.
 *
 * The compute function is the load-bearing piece — it decides which
 * rows the user is about to spend money regenerating. Pinning its
 * behavior makes the cost gate trustworthy.
 *
 * PR 3 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FlipOstToOverlayModal,
  computeAffectedRows,
  type AffectedRow,
} from '@/components/editor/FlipOstToOverlayModal';
import type { ProductionDoc } from '@/remotion/utils';

function rowWith(fields: Partial<ProductionDoc['rows'][number]>): ProductionDoc['rows'][number] {
  return {
    timecode: '0:00',
    script_text: '',
    visual_type: 'B-Roll',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    ...fields,
  };
}

function makeDoc(rows: ProductionDoc['rows'], docDefault?: 'bake' | 'overlay' | 'none'): ProductionDoc {
  return {
    title: 'T',
    niche: 'X',
    total_duration: '0:30',
    total_words: 60,
    speaking_pace_wpm: 120,
    rows,
    on_screen_text_mode_default: docDefault,
  };
}

describe('computeAffectedRows — the cost gate is built on this', () => {
  it('flags rows with on_screen_text + effective mode bake + rendered image', () => {
    const doc = makeDoc([
      rowWith({ on_screen_text: 'Hello', on_screen_text_mode: 'bake' }),
      rowWith({ on_screen_text: 'World', on_screen_text_mode: 'bake' }),
    ]);
    const rowImages = { 0: 'https://example.com/0.png', 1: 'https://example.com/1.png' };
    const affected = computeAffectedRows(doc, rowImages);
    expect(affected).toHaveLength(2);
    expect(affected[0]).toEqual({ rowIndex: 0, onScreenText: 'Hello' });
    expect(affected[1]).toEqual({ rowIndex: 1, onScreenText: 'World' });
  });

  it('treats undefined row mode as inheriting the doc default', () => {
    // Doc default = 'bake'; row mode undefined ⇒ effective = bake ⇒ affected.
    const docBake = makeDoc(
      [rowWith({ on_screen_text: 'Hello' })],
      'bake',
    );
    expect(computeAffectedRows(docBake, { 0: 'x.png' })).toHaveLength(1);
    // Doc default = 'overlay'; row mode undefined ⇒ effective = overlay ⇒ NOT affected.
    const docOverlay = makeDoc(
      [rowWith({ on_screen_text: 'Hello' })],
      'overlay',
    );
    expect(computeAffectedRows(docOverlay, { 0: 'x.png' })).toHaveLength(0);
  });

  it('treats both undefined as legacy fallback to bake', () => {
    // No row mode, no doc default — legacy docs fall through to 'bake'.
    const doc = makeDoc([rowWith({ on_screen_text: 'Hello' })]);
    expect(computeAffectedRows(doc, { 0: 'x.png' })).toHaveLength(1);
  });

  it('skips rows where on_screen_text is empty or whitespace-only', () => {
    const doc = makeDoc(
      [
        rowWith({ on_screen_text: '', on_screen_text_mode: 'bake' }),
        rowWith({ on_screen_text: '   ', on_screen_text_mode: 'bake' }),
        rowWith({ on_screen_text: undefined, on_screen_text_mode: 'bake' }),
        rowWith({ on_screen_text: 'real', on_screen_text_mode: 'bake' }),
      ],
      'bake',
    );
    const rowImages = { 0: 'a', 1: 'b', 2: 'c', 3: 'd' };
    const affected = computeAffectedRows(doc, rowImages);
    expect(affected).toHaveLength(1);
    expect(affected[0].rowIndex).toBe(3);
  });

  it('respects per-row overlay/none overrides', () => {
    const doc = makeDoc(
      [
        rowWith({ on_screen_text: 'overlay', on_screen_text_mode: 'overlay' }),
        rowWith({ on_screen_text: 'none', on_screen_text_mode: 'none' }),
        rowWith({ on_screen_text: 'bake', on_screen_text_mode: 'bake' }),
      ],
      'bake',
    );
    const affected = computeAffectedRows(doc, { 0: 'a', 1: 'b', 2: 'c' });
    expect(affected.map((r) => r.rowIndex)).toEqual([2]);
  });

  it('skips rows that never had an image (no money was spent on baked pixels there)', () => {
    const doc = makeDoc(
      [
        rowWith({ on_screen_text: 'no-image', on_screen_text_mode: 'bake' }),
        rowWith({ on_screen_text: 'has-image', on_screen_text_mode: 'bake' }),
      ],
      'bake',
    );
    const rowImages = { 1: 'https://example.com/1.png' };
    const affected = computeAffectedRows(doc, rowImages);
    expect(affected).toHaveLength(1);
    expect(affected[0].rowIndex).toBe(1);
  });
});

describe('FlipOstToOverlayModal — visible cost gate', () => {
  const noopRows: readonly AffectedRow[] = [];
  const someRows: readonly AffectedRow[] = [
    { rowIndex: 0, onScreenText: 'First' },
    { rowIndex: 5, onScreenText: 'Sixth' },
  ];

  it('renders the affected count, per-image cost, and total estimate', () => {
    const html = renderToStaticMarkup(
      <FlipOstToOverlayModal
        affectedRows={someRows}
        perImageCostLabel="$0.011 / image (Test)"
        perImageCostUsd={0.011}
        totalRowCount={50}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain('Affected rows');
    expect(html).toContain('<strong>2</strong>');
    expect(html).toContain('of 50');
    expect(html).toContain('$0.011 / image (Test)');
    expect(html).toContain('Estimated total');
    expect(html).toContain('<strong>$0.02</strong>'); // 2 * $0.011 = $0.022 → $0.02
  });

  it('shows a preview list of the first affected shots', () => {
    const html = renderToStaticMarkup(
      <FlipOstToOverlayModal
        affectedRows={someRows}
        perImageCostLabel="$0.011 / image"
        perImageCostUsd={0.011}
        totalRowCount={50}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain('First');
    expect(html).toContain('Sixth');
    expect(html).toContain('#1');
    expect(html).toContain('#6');
  });

  it('disables the Run button + shows "Nothing to do" when no rows affected', () => {
    const html = renderToStaticMarkup(
      <FlipOstToOverlayModal
        affectedRows={noopRows}
        perImageCostLabel="$0.011 / image"
        perImageCostUsd={0.011}
        totalRowCount={50}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain('Nothing to do');
    expect(html).toContain('disabled');
  });

  it('truncates the preview list at 6 and shows a "more" hint', () => {
    const manyRows: readonly AffectedRow[] = Array.from({ length: 10 }, (_, i) => ({
      rowIndex: i,
      onScreenText: `Row ${i + 1} text`,
    }));
    const html = renderToStaticMarkup(
      <FlipOstToOverlayModal
        affectedRows={manyRows}
        perImageCostLabel="$0.011 / image"
        perImageCostUsd={0.011}
        totalRowCount={20}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain('Row 1 text');
    expect(html).toContain('Row 6 text');
    expect(html).not.toContain('Row 7 text');
    expect(html).toContain('and 4 more');
  });

  it('shows dialog accessibility attributes', () => {
    const html = renderToStaticMarkup(
      <FlipOstToOverlayModal
        affectedRows={someRows}
        perImageCostLabel="$0.011 / image"
        perImageCostUsd={0.011}
        totalRowCount={50}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });
});

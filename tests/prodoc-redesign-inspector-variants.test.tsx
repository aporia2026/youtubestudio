/**
 * Variants tab routing in the Studio inspector. Phase R3 PR4d of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * The tab body is the existing `VariantPanel` from `editor/`. This
 * suite covers the routing contract that mounts it — the panel's
 * own behaviour (standalone vs base vs variant branches) is tested
 * in the editor-variants-and-titlecards suite. Mounting in read-only
 * mode (no writers passed) so the panel shows its informative-text
 * branch.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioInspector } from '@/components/production-doc/redesign/StudioInspector';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import type { EditorWriters } from '@/components/production-doc/editor/types';

/** Minimal no-op EditorWriters stub — every callback is a function
 *  that does nothing, which is enough for the SSR test environment.
 *  Real behaviour is exercised by the editor's own test suite. */
const NOOP_WRITERS: EditorWriters = {
  updateRow: () => {},
  applyTitleToRange: () => {},
  applyPillarboxColorToAll: () => {},
  clearPillarboxOverrides: () => {},
  applyStripeLayoutToAll: () => {},
  clearStripeLayoutOverrides: () => {},
  applySceneZoomToAll: () => {},
  clearSceneZoomOverrides: () => {},
  applyRegionZoomPaddingToAll: () => {},
  applyTitleCardAsSectionTitle: () => {},
  fetchOverlayForRow: () => {},
  generateImageForRow: () => {},
  uploadImageForRow: () => {},
  importImageUrlForRow: () => {},
  openEditPanelForRow: () => {},
  openOverlayPositionEditorForRow: () => {},
  handleBrollClipChange: () => {},
  toggleRowLock: () => {},
  computeRowSceneDurationMs: () => 0,
  addVariantRow: () => {},
  generateVariantImage: () => Promise.resolve(),
  generateAllVariantsInGroup: () => Promise.resolve(),
  deleteVariantRow: () => {},
  moveVariantRow: () => {},
};

function makeRow(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '0:00',
    script_text: '',
    visual_type: 'B-Roll',
    visual_description: '',
    stock_search_terms: '',
    ai_image_prompt: '',
    on_screen_text: '',
    notes: '',
    ...overrides,
  } as ProductionRow;
}

function makeDoc(rows: ProductionRow[]): ProductionDoc {
  return {
    title: 'sample',
    niche: 'finance',
    total_duration: '1:00',
    total_words: 100,
    speaking_pace_wpm: 125,
    rows,
  };
}

describe('StudioInspector — tab routing for Variants (R3 PR4d)', () => {
  it('mounts VariantPanel when initialTab="variants", a row is selected, and the doc is provided', () => {
    const row = makeRow({ visual_type: 'Title Card' });
    const doc = makeDoc([row]);
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={row}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="variants"
        doc={doc}
        rowImagesByIndex={[undefined]}
      />,
    );
    // Read-only branch of the panel — recognisable phrasing.
    expect(html).toContain('Standalone row — not part of a variant group');
    expect(html).toContain('Switch to edit mode to manage variants');
    // Should NOT show the lands-in-later placeholder.
    expect(html).not.toContain('lands in later R3 PRs');
  });

  it('shows the group description for a variant base row', () => {
    const base = makeRow({
      timecode: '0:00',
      group_id: 'g1',
      variant_index: 0,
    } as Partial<ProductionRow>);
    const child = makeRow({
      timecode: '0:05',
      group_id: 'g1',
      variant_index: 1,
    } as Partial<ProductionRow>);
    const doc = makeDoc([base, child]);
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={base}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="variants"
        doc={doc}
        rowImagesByIndex={[undefined, undefined]}
      />,
    );
    expect(html).toMatch(/Part of a 2-row variant group/);
    expect(html).toContain('base');
  });

  it('falls back to the lands-in-later placeholder when doc is not provided', () => {
    // Without a doc the panel can't walk the variant group, so the
    // routing condition fails and the tab hits the placeholder.
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow()}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="variants"
      />,
    );
    expect(html).toContain('Tab editing lands in later R3 PRs');
  });

  it('keeps the empty-state prompt when no row is selected on the variants tab', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        initialTab="variants"
        doc={makeDoc([makeRow()])}
      />,
    );
    expect(html).toContain('Select a row');
  });
});

describe('StudioInspector — Variants tab editable (writers wired)', () => {
  it('omits the "Switch to edit mode" hint when editorWriters is provided', () => {
    const row = makeRow();
    const doc = makeDoc([row]);
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={row}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="variants"
        doc={doc}
        rowImagesByIndex={[undefined]}
        editorWriters={NOOP_WRITERS}
      />,
    );
    expect(html).not.toContain('Switch to edit mode to manage variants');
  });

  it('shows the "+ Add variant" affordance for a standalone row when editable', () => {
    const row = makeRow();
    const doc = makeDoc([row]);
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={row}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="variants"
        doc={doc}
        rowImagesByIndex={[undefined]}
        editorWriters={NOOP_WRITERS}
      />,
    );
    // Standalone branch in editable mode shows the Add affordance.
    expect(html).toMatch(/Add variant/i);
  });

  it('keeps the read-only branch when editorWriters is not provided', () => {
    const row = makeRow();
    const doc = makeDoc([row]);
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={row}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="variants"
        doc={doc}
        rowImagesByIndex={[undefined]}
      />,
    );
    expect(html).toContain('Switch to edit mode to manage variants');
  });
});

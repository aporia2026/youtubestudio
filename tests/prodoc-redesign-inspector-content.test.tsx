/**
 * StudioInspectorContent — read-only Content tab body in the Studio
 * inspector. Phase R3 PR3 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Also covers the StudioInspector wiring that mounts the Content body
 * when a row is selected.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioInspectorContent } from '@/components/production-doc/redesign/StudioInspectorContent';
import { StudioInspector } from '@/components/production-doc/redesign/StudioInspector';
import type { ProductionRow } from '@/remotion/utils';

function makeRow(overrides: Partial<ProductionRow> = {}): ProductionRow {
  return {
    timecode: '0:42',
    script_text: 'Once Bob starts saving at 25, his money compounds.',
    visual_type: 'Title Card',
    visual_description: 'Bob holds a piggy bank, soft pastels.',
    stock_search_terms: '',
    ai_image_prompt: 'Hand-drawn doodle of a young man with a piggy bank.',
    on_screen_text: 'Start saving',
    notes: '',
    ...overrides,
  } as ProductionRow;
}

describe('StudioInspectorContent — rendering', () => {
  it('renders every populated field with its label', () => {
    const html = renderToStaticMarkup(<StudioInspectorContent rowIndex={0} row={makeRow()} />);
    expect(html).toContain('Visual type');
    expect(html).toContain('Title Card');
    expect(html).toContain('Script');
    expect(html).toContain('Once Bob starts saving at 25');
    expect(html).toContain('AI prompt');
    expect(html).toContain('Hand-drawn doodle of a young man');
    expect(html).toContain('Visual description');
    expect(html).toContain('Bob holds a piggy bank');
    expect(html).toContain('On-screen text');
    expect(html).toContain('Start saving');
  });

  it('omits stock_search_terms when empty', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorContent rowIndex={0} row={makeRow({ stock_search_terms: '' })} />,
    );
    expect(html).not.toContain('Stock search terms');
  });

  it('shows stock_search_terms when present', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorContent
        rowIndex={0}
        row={makeRow({ stock_search_terms: 'businessman handshake' })}
      />,
    );
    expect(html).toContain('Stock search terms');
    expect(html).toContain('businessman handshake');
  });

  it('omits notes when empty and shows them when present', () => {
    const emptyHtml = renderToStaticMarkup(
      <StudioInspectorContent rowIndex={0} row={makeRow({ notes: '' })} />,
    );
    expect(emptyHtml).not.toContain('Notes');

    const withNotesHtml = renderToStaticMarkup(
      <StudioInspectorContent rowIndex={0} row={makeRow({ notes: 'rerender after voiceover lands' })} />,
    );
    expect(withNotesHtml).toContain('Notes');
    expect(withNotesHtml).toContain('rerender after voiceover lands');
  });
});

describe('StudioInspectorContent — empty fields', () => {
  it('renders a — placeholder when script is blank instead of hiding the field', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorContent rowIndex={0} row={makeRow({ script_text: '' })} />,
    );
    // Script label still present, value renders the placeholder.
    expect(html).toContain('Script');
    expect(html).toContain('—');
  });

  it('treats whitespace-only fields as empty for placeholder purposes', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorContent rowIndex={0} row={makeRow({ on_screen_text: '   ' })} />,
    );
    // The whitespace value should be replaced with the placeholder.
    expect(html).toMatch(/On-screen text[\s\S]*?—/);
  });
});

describe('StudioInspectorContent — visual type', () => {
  it('renders the "Visual type" label even when the row has no visual type (so the read-only display falls back to —)', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorContent rowIndex={0} row={makeRow({ visual_type: '' })} />,
    );
    // Label always renders so the field is discoverable; value falls
    // back to the "—" placeholder in read mode.
    expect(html).toContain('Visual type');
    expect(html).toContain('—');
  });

  it('uses a token-based color for known visual types', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorContent rowIndex={0} row={makeRow({ visual_type: 'B-Roll' })} />,
    );
    // B-Roll's documented color is #22d3ee per the shared token map.
    expect(html).toContain('#22d3ee');
  });
});

describe('StudioInspector — selection wiring (R3 PR3)', () => {
  it('renders the Content tab body when a row is selected and currentTab=content', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow({ script_text: 'wired through correctly' })}
        selectedRowIndex={4}
        selectedRowLabel="0:42"
        initialTab="content"
      />,
    );
    expect(html).toContain('Row 4');
    expect(html).toContain('0:42');
    expect(html).toContain('wired through correctly');
    expect(html).not.toContain('Select a row');
  });

  it('keeps the empty-state prompt when no row is selected even with currentTab=content', () => {
    const html = renderToStaticMarkup(<StudioInspector initialTab="content" />);
    expect(html).toContain('Select a row');
    expect(html).not.toContain('Tab editing lands in');
  });

  it('shows the "later phases" placeholder for tabs that have not been mounted yet', () => {
    // R3 PR4 lit up Image. R3 PR4c lit up Video. R3 PR5 lit up
    // Overlay + Section. Variants is the only remaining tab that
    // still hits the placeholder when a row is selected.
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow()}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="variants"
      />,
    );
    expect(html).toContain('Tab editing lands in later R3 PRs');
    expect(html).not.toContain('Select a row');
  });
});

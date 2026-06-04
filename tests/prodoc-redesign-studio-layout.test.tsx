/**
 * StudioLayout / StudioLeftRail / StudioInspector — three-column
 * Studio Mode chrome. Phase R3 PR2 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Also covers the new `orientation` prop on StudioLegend (default
 * horizontal, left-rail mounts with vertical).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioLayout } from '@/components/production-doc/redesign/StudioLayout';
import { StudioLeftRail } from '@/components/production-doc/redesign/StudioLeftRail';
import { StudioInspector } from '@/components/production-doc/redesign/StudioInspector';
import { StudioLegend } from '@/components/production-doc/redesign/StudioLegend';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';

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

describe('StudioLegend — orientation prop', () => {
  it('defaults to horizontal orientation (back-compat with R2 PR2)', () => {
    const html = renderToStaticMarkup(
      <StudioLegend doc={makeDoc([makeRow({ visual_type: 'B-Roll' })])} />,
    );
    expect(html).toMatch(/data-orientation="horizontal"/);
    // Horizontal uses flex-wrap so pills sit side by side.
    expect(html).toContain('flex-wrap');
  });

  it('switches to a vertical column when orientation="vertical"', () => {
    const html = renderToStaticMarkup(
      <StudioLegend
        doc={makeDoc([makeRow({ visual_type: 'B-Roll' })])}
        orientation="vertical"
      />,
    );
    expect(html).toMatch(/data-orientation="vertical"/);
    expect(html).toContain('flex-col');
    expect(html).not.toContain('flex-wrap');
  });
});

describe('StudioLayout — three-column grid', () => {
  it('renders aria-labelled landmarks for each column', () => {
    const html = renderToStaticMarkup(
      <StudioLayout
        leftRail={<span>RAIL</span>}
        mainContent={<span>MAIN</span>}
        inspector={<span>INSPECT</span>}
      />,
    );
    expect(html).toMatch(/<aside[^>]*aria-label="Studio left rail"/);
    expect(html).toMatch(/<main[^>]*aria-label="Studio main content"/);
    expect(html).toMatch(/<aside[^>]*aria-label="Studio inspector"/);
  });

  it('places columns in left → main → right DOM order', () => {
    const html = renderToStaticMarkup(
      <StudioLayout
        leftRail={<span>RAIL_TOKEN</span>}
        mainContent={<span>MAIN_TOKEN</span>}
        inspector={<span>INSPECT_TOKEN</span>}
      />,
    );
    const railIdx = html.indexOf('RAIL_TOKEN');
    const mainIdx = html.indexOf('MAIN_TOKEN');
    const inspectIdx = html.indexOf('INSPECT_TOKEN');
    expect(railIdx).toBeGreaterThanOrEqual(0);
    expect(mainIdx).toBeGreaterThan(railIdx);
    expect(inspectIdx).toBeGreaterThan(mainIdx);
  });

  it('uses a three-column grid template (200px / 1fr / 380px per §10)', () => {
    const html = renderToStaticMarkup(
      <StudioLayout
        leftRail={<span>r</span>}
        mainContent={<span>m</span>}
        inspector={<span>i</span>}
      />,
    );
    expect(html).toMatch(/grid-template-columns:\s*200px minmax\(0, 1fr\) 380px/);
  });
});

describe('StudioLeftRail — content', () => {
  it('mounts the StudioLegend in vertical orientation', () => {
    const html = renderToStaticMarkup(
      <StudioLeftRail doc={makeDoc([makeRow({ visual_type: 'B-Roll' })])} />,
    );
    expect(html).toMatch(/data-orientation="vertical"/);
    expect(html).toContain('B-Roll');
  });

  it('renders a Legend section heading', () => {
    const html = renderToStaticMarkup(
      <StudioLeftRail doc={makeDoc([makeRow({ visual_type: 'B-Roll' })])} />,
    );
    expect(html).toMatch(/id="left-rail-legend-heading"[^>]*>\s*Legend/);
  });

  it('renders an empty rail when the doc has no rows (no broken Legend chrome)', () => {
    const html = renderToStaticMarkup(<StudioLeftRail doc={makeDoc([])} />);
    // Heading still renders but the Legend inside collapses to nothing.
    expect(html).toContain('Legend');
    // No pills, no broken-looking markup.
    expect(html).not.toContain('aria-label="Scene type breakdown"');
  });
});

describe('StudioInspector — chrome', () => {
  it('mounts the InspectorTabBar', () => {
    const html = renderToStaticMarkup(<StudioInspector />);
    expect(html).toMatch(/role="tablist"[^>]*aria-label="Row inspector tabs"/);
  });

  it('uses a section landmark with an accessible label', () => {
    const html = renderToStaticMarkup(<StudioInspector />);
    expect(html).toMatch(/<section[^>]*aria-label="Row inspector"/);
  });

  it('renders the tab panel with the documented ARIA wiring', () => {
    const html = renderToStaticMarkup(<StudioInspector />);
    // Default tab is "content" so the panel id matches.
    expect(html).toMatch(
      /role="tabpanel"[^>]*aria-labelledby="inspector-tab-content"/,
    );
    expect(html).toContain('id="inspector-panel-content"');
  });

  it('honors the currentTab prop', () => {
    const html = renderToStaticMarkup(<StudioInspector currentTab="overlay" />);
    expect(html).toMatch(
      /role="tabpanel"[^>]*aria-labelledby="inspector-tab-overlay"/,
    );
    expect(html).toContain('id="inspector-panel-overlay"');
  });
});

describe('StudioInspector — empty state vs selection', () => {
  it('shows the "Select a row" prompt when no row is selected', () => {
    const html = renderToStaticMarkup(<StudioInspector />);
    expect(html).toContain('Select a row');
  });

  it('shows the row meta line when a row is selected', () => {
    const html = renderToStaticMarkup(
      <StudioInspector selectedRowIndex={4} selectedRowLabel="Title Card" />,
    );
    expect(html).toContain('Row 4');
    expect(html).toContain('Title Card');
    expect(html).not.toContain('Select a row');
  });

  it('omits the row meta line when only the index is provided (label is required for human-readable context)', () => {
    const html = renderToStaticMarkup(<StudioInspector selectedRowIndex={4} />);
    expect(html).not.toContain('Row 4');
  });
});

/**
 * StudioInspectorOverlay + StudioInspectorSection — read-only Overlay
 * and Section tab bodies, plus the StudioInspector tab routing.
 * Phase R3 PR5 of `_plans/2026-06-04-production-doc-redesign.md`.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioInspectorOverlay } from '@/components/production-doc/redesign/StudioInspectorOverlay';
import { StudioInspectorSection } from '@/components/production-doc/redesign/StudioInspectorSection';
import { StudioInspector } from '@/components/production-doc/redesign/StudioInspector';
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

function makeDoc(overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    title: 'sample',
    niche: 'finance',
    total_duration: '1:00',
    total_words: 100,
    speaking_pace_wpm: 125,
    rows: [],
    ...overrides,
  };
}

// ─── StudioInspectorOverlay ────────────────────────────────────────

describe('StudioInspectorOverlay — empty state', () => {
  it('renders the "no overlay configured" prompt when no overlay state and no stock terms', () => {
    const html = renderToStaticMarkup(<StudioInspectorOverlay />);
    expect(html).toContain('This row has no overlay configured');
  });

  it('shows the stock terms even when overlay state is null (pre-fetch)', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorOverlay stockTerms="businessman handshake" />,
    );
    expect(html).toContain('Stock search terms');
    expect(html).toContain('businessman handshake');
    expect(html).not.toContain('This row has no overlay configured');
  });
});

describe('StudioInspectorOverlay — status pill', () => {
  it.each([
    ['idle', 'Not fetched'],
    ['loading', 'Fetching'],
    ['done', 'Ready'],
    ['skipped', 'Skipped'],
    ['error', 'Failed'],
  ] as const)('renders the documented label for status=%s', (status, expected) => {
    const html = renderToStaticMarkup(
      <StudioInspectorOverlay overlay={{ status }} stockTerms="x" />,
    );
    expect(html).toContain(expected);
  });
});

describe('StudioInspectorOverlay — image preview', () => {
  it('renders the transparent overlay thumbnail when status=done and url is set', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorOverlay
        overlay={{ status: 'done', url: 'https://example.com/overlay.png' }}
      />,
    );
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/overlay\.png"/);
    expect(html).toMatch(/alt="Overlay image for the selected row"/);
  });

  it('omits the preview when status is not done', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorOverlay
        overlay={{ status: 'loading', url: 'https://example.com/overlay.png' }}
      />,
    );
    expect(html).not.toContain('<img');
  });
});

describe('StudioInspectorOverlay — error display', () => {
  it('renders the error message when status=error and error is set', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorOverlay
        overlay={{ status: 'error', error: 'No matching stock image found' }}
        stockTerms="rare specific phrase"
      />,
    );
    expect(html).toContain('No matching stock image found');
  });
});

// ─── StudioInspectorSection ────────────────────────────────────────

describe('StudioInspectorSection — field display', () => {
  it('renders the row section title when set', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorSection row={makeRow({ section_title: 'How compounding works' })} />,
    );
    expect(html).toContain('Section title');
    expect(html).toContain('How compounding works');
  });

  it('renders the placeholder when section title is empty', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorSection row={makeRow({ section_title: '' })} />,
    );
    expect(html).toMatch(/Section title[\s\S]*?—/);
  });

  it('renders the scene zoom as a percentage', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorSection row={makeRow({ scene_zoom: 120 })} />,
    );
    expect(html).toMatch(/Scene zoom[\s\S]*?120%/);
  });

  it('renders the region zoom padding as a percentage', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorSection row={makeRow({ region_zoom_padding_pct: 25 })} />,
    );
    expect(html).toMatch(/Region zoom padding[\s\S]*?25%/);
  });

  it('renders Scene fade On/Off label, not raw boolean', () => {
    const onHtml = renderToStaticMarkup(
      <StudioInspectorSection row={makeRow({ scene_fade: true })} />,
    );
    expect(onHtml).toMatch(/Scene fade[\s\S]*?On/);

    const offHtml = renderToStaticMarkup(
      <StudioInspectorSection row={makeRow({ scene_fade: false })} />,
    );
    expect(offHtml).toMatch(/Scene fade[\s\S]*?Off/);
  });

  it('renders the pillarbox color with a hex swatch when the value is a valid hex', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorSection row={makeRow({ pillarbox_color: '#aabbcc' })} />,
    );
    expect(html).toContain('#aabbcc');
    // Swatch span uses inline-block + background-color set to the hex.
    expect(html).toMatch(/background:\s*#aabbcc/);
  });

  it('renders the transition kind when set, placeholder otherwise', () => {
    const setHtml = renderToStaticMarkup(
      <StudioInspectorSection
        row={makeRow({ thumbnail_transition: { kind: 'pan' } as never })}
      />,
    );
    expect(setHtml).toMatch(/Transition[\s\S]*?pan/);

    const unsetHtml = renderToStaticMarkup(
      <StudioInspectorSection row={makeRow()} />,
    );
    expect(unsetHtml).toMatch(/Transition[\s\S]*?—/);
  });
});

describe('StudioInspectorSection — inherited indicators', () => {
  it('marks Title layout "inherited" when the row has no override and doc has a default', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorSection
        row={makeRow()}
        doc={makeDoc({ section_title_layout_default: 'overlay' })}
      />,
    );
    expect(html).toMatch(/Title layout[\s\S]*?inherited[\s\S]*?overlay/);
  });

  it('does not mark Title layout "inherited" when the row has its own override', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorSection
        row={makeRow({ section_title_layout: 'letterbox' })}
        doc={makeDoc({ section_title_layout_default: 'overlay' })}
      />,
    );
    // The row's letterbox should win.
    expect(html).toMatch(/Title layout[\s\S]*?letterbox/);
    // And the "inherited" badge should not appear next to it.
    expect(html).not.toMatch(/Title layout[\s\S]*?inherited[\s\S]*?letterbox/);
  });

  it('marks Pillarbox color "inherited" when row has no override and doc has a default', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorSection
        row={makeRow()}
        doc={makeDoc({ pillarbox_color_default: '#112233' })}
      />,
    );
    expect(html).toMatch(/Pillarbox color[\s\S]*?inherited/);
    expect(html).toContain('#112233');
  });

  it('marks Scene fade "inherited" when row has no override', () => {
    const html = renderToStaticMarkup(<StudioInspectorSection row={makeRow()} />);
    expect(html).toMatch(/Scene fade[\s\S]*?inherited/);
  });

  it('marks Scene zoom "inherited" with the built-in default of 100% when row has no override', () => {
    const html = renderToStaticMarkup(<StudioInspectorSection row={makeRow()} />);
    expect(html).toMatch(/Scene zoom[\s\S]*?inherited[\s\S]*?100%/);
  });
});

// ─── StudioInspector tab routing for Overlay + Section ──────────────

describe('StudioInspector — tab routing for Overlay (R3 PR5)', () => {
  it('mounts StudioInspectorOverlay when initialTab="overlay" and a row is selected', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow({ stock_search_terms: 'compound interest chart' })}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="overlay"
        selectedRowOverlay={{
          status: 'done',
          url: 'https://example.com/overlay.png',
        }}
      />,
    );
    expect(html).toContain('Ready');
    expect(html).toContain('compound interest chart');
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/overlay\.png"/);
    expect(html).not.toContain('lands in later R3 PRs');
  });

  it('shows the "no overlay configured" prompt when row has no stock terms or overlay state', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow()}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="overlay"
      />,
    );
    expect(html).toContain('This row has no overlay configured');
  });
});

describe('StudioInspector — tab routing for Section (R3 PR5)', () => {
  it('mounts StudioInspectorSection when initialTab="section" and a row is selected', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow({ section_title: 'The setup' })}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="section"
      />,
    );
    expect(html).toContain('Section title');
    expect(html).toContain('The setup');
    expect(html).not.toContain('lands in later R3 PRs');
  });

  it('forwards the doc-level defaults so the Section tab can show inherited values', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow()}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="section"
        doc={makeDoc({ section_title_layout_default: 'overlay' })}
      />,
    );
    expect(html).toMatch(/Title layout[\s\S]*?inherited[\s\S]*?overlay/);
  });
});

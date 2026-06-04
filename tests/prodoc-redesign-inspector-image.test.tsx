/**
 * StudioInspectorImage — read-only Image tab body.
 * Phase R3 PR4 of `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Also covers the StudioInspector tab routing that mounts the Image
 * body when `currentTab === 'image'` and a row is selected.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioInspectorImage } from '@/components/production-doc/redesign/StudioInspectorImage';
import { StudioInspector } from '@/components/production-doc/redesign/StudioInspector';
import type { RowImageStateView } from '@/components/production-doc/editor/types';
import type { ProductionRow } from '@/remotion/utils';

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

describe('StudioInspectorImage — empty state', () => {
  it('renders the "no image yet" prompt when state is null', () => {
    const html = renderToStaticMarkup(<StudioInspectorImage state={null} />);
    expect(html).toContain('No image has been generated for this row yet.');
  });

  it('renders the "no image yet" prompt when state is omitted', () => {
    const html = renderToStaticMarkup(<StudioInspectorImage />);
    expect(html).toContain('No image has been generated for this row yet.');
  });
});

describe('StudioInspectorImage — status pill', () => {
  it.each<[RowImageStateView['status'], string]>([
    ['idle', 'No image yet'],
    ['pending', 'Queued'],
    ['loading', 'Generating'],
    ['uploading', 'Uploading'],
    ['editing', 'Editing'],
    ['done', 'Ready'],
    ['error', 'Failed'],
    ['search', 'Searching'],
  ])('renders the documented label for status=%s', (status, expected) => {
    const html = renderToStaticMarkup(<StudioInspectorImage state={{ status }} />);
    expect(html).toContain(expected);
  });
});

describe('StudioInspectorImage — image preview', () => {
  it('renders the thumbnail when imageUrl is present', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage
        state={{ status: 'done', imageUrl: 'https://example.com/img.png' }}
      />,
    );
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/img\.png"/);
    expect(html).toMatch(/alt="Generated still for the selected row"/);
  });

  it('omits the thumbnail when imageUrl is absent', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage state={{ status: 'idle' }} />,
    );
    expect(html).not.toContain('<img');
  });
});

describe('StudioInspectorImage — source label', () => {
  it.each<[NonNullable<RowImageStateView['source']>, string]>([
    ['generated', 'AI generated'],
    ['upload', 'Uploaded'],
    ['url', 'Imported from URL'],
    ['edit', 'Edited'],
  ])('renders the documented label for source=%s', (source, expected) => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage state={{ status: 'done', source }} />,
    );
    expect(html).toContain(expected);
  });

  it('omits the source pill when source is undefined', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage state={{ status: 'done' }} />,
    );
    expect(html).not.toContain('AI generated');
    expect(html).not.toContain('Uploaded');
    expect(html).not.toContain('Imported from URL');
    expect(html).not.toContain('Edited');
  });
});

describe('StudioInspectorImage — error display', () => {
  it('renders the error message when status=error and error is set', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage
        state={{ status: 'error', error: 'Upstream provider rejected the prompt' }}
      />,
    );
    expect(html).toContain('Upstream provider rejected the prompt');
  });

  it('omits the error box when status=error but no error message is set', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage state={{ status: 'error' }} />,
    );
    // The status pill still says "Failed", but no separate red box.
    expect(html).toContain('Failed');
    // The error box uses a red border — no border means no box.
    expect(html).not.toMatch(/border:\s*1px solid rgba\(239,68,68/);
  });

  it('does not render the error box when status is not error, even if error is somehow set', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage
        state={{ status: 'done', error: 'stale error from earlier attempt' }}
      />,
    );
    expect(html).not.toContain('stale error from earlier attempt');
  });
});

describe('StudioInspector — tab routing for Image', () => {
  it('mounts StudioInspectorImage when initialTab="image" and a row is selected', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow()}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="image"
        selectedRowImageState={{
          status: 'done',
          imageUrl: 'https://example.com/img.png',
          source: 'generated',
        }}
      />,
    );
    // Status pill from the Image body.
    expect(html).toContain('Ready');
    // Source pill.
    expect(html).toContain('AI generated');
    // Thumbnail.
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/img\.png"/);
    // Should NOT show the placeholder for "lands in later R3 PRs".
    expect(html).not.toContain('lands in later R3 PRs');
  });

  it('shows the "no image yet" prompt when row is selected, image tab, and no image state passed', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow()}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="image"
      />,
    );
    expect(html).toContain('No image has been generated for this row yet.');
  });

  it('still shows the empty-state row prompt when no row is selected even with image state', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        initialTab="image"
        selectedRowImageState={{ status: 'done', imageUrl: 'https://x/y.png' }}
      />,
    );
    expect(html).toContain('Select a row');
    expect(html).not.toMatch(/<img/);
  });
});

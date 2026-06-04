/**
 * StudioInspectorImage — Image tab body (read-only + editable modes).
 * Phase R3 PR4 / R3 PR4b of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * R3 PR4 covered the read-only render. R3 PR4b adds the writer-
 * callback contract: Generate / Re-generate / Upload / Import URL /
 * Edit / Retry buttons appear only when their callback is wired, and
 * a `canGenerate=false` disables (not hides) the Generate button so
 * the lazy user sees an affordance + a reason in the tooltip.
 *
 * Click-driven button behaviour relies on real DOM events that the
 * project's SSR test environment does not run; the tests below pin
 * which controls render under which conditions and rely on TypeScript
 * + React for the click-to-callback wiring.
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

describe('StudioInspectorImage — action buttons (R3 PR4b)', () => {
  it('renders Generate when state=idle and onGenerate is wired', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage state={{ status: 'idle' }} onGenerate={() => {}} />,
    );
    expect(html).toMatch(/<button[^>]*>\s*Generate\s*<\/button>/);
  });

  it('renders ↻ Re-generate when an image already exists and onGenerate is wired', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage
        state={{ status: 'done', imageUrl: 'https://x/y.png' }}
        onGenerate={() => {}}
      />,
    );
    expect(html).toContain('↻ Re-generate');
    expect(html).not.toMatch(/>\s*Generate\s*</);
  });

  it('disables Generate (but still renders it) when canGenerate=false', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage
        state={{ status: 'idle' }}
        onGenerate={() => {}}
        canGenerate={false}
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Generate\s*<\/button>/);
    expect(html).toMatch(/title="[^"]*This row has no AI prompt/);
  });

  it('renders Upload when onUpload is wired and the row is not busy', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage state={{ status: 'idle' }} onUpload={() => {}} />,
    );
    expect(html).toContain('⬆ Upload');
    // Hidden file input is mounted so the button can trigger it.
    expect(html).toMatch(/<input[^>]*type="file"/);
  });

  it('renders Import URL when onImportUrl is wired', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage state={{ status: 'idle' }} onImportUrl={() => {}} />,
    );
    expect(html).toContain('🔗 Import URL');
  });

  it('renders ✎ Edit only when an image exists AND onEdit is wired', () => {
    const noImageHtml = renderToStaticMarkup(
      <StudioInspectorImage state={{ status: 'idle' }} onEdit={() => {}} />,
    );
    expect(noImageHtml).not.toContain('✎ Edit');

    const withImageHtml = renderToStaticMarkup(
      <StudioInspectorImage
        state={{ status: 'done', imageUrl: 'https://x/y.png' }}
        onEdit={() => {}}
      />,
    );
    expect(withImageHtml).toContain('✎ Edit');
  });

  it('renders Retry only when status=error AND onRetry is wired', () => {
    const errorHtml = renderToStaticMarkup(
      <StudioInspectorImage
        state={{ status: 'error', error: 'whoops' }}
        onRetry={() => {}}
      />,
    );
    expect(errorHtml).toMatch(/<button[^>]*>\s*Retry\s*<\/button>/);

    const doneHtml = renderToStaticMarkup(
      <StudioInspectorImage
        state={{ status: 'done', imageUrl: 'https://x/y.png' }}
        onRetry={() => {}}
      />,
    );
    expect(doneHtml).not.toMatch(/<button[^>]*>\s*Retry\s*<\/button>/);
  });

  it('hides ALL action buttons while the row is busy (loading / uploading / etc.)', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage
        state={{ status: 'loading' }}
        onGenerate={() => {}}
        onUpload={() => {}}
        onImportUrl={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(html).not.toContain('Generate');
    expect(html).not.toContain('⬆ Upload');
    expect(html).not.toContain('🔗 Import URL');
    expect(html).not.toContain('✎ Edit');
  });

  it('hides every button when no callback is wired (read-only contract from R3 PR4)', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorImage state={{ status: 'idle' }} />,
    );
    expect(html).not.toContain('Generate');
    expect(html).not.toContain('Upload');
    expect(html).not.toContain('Import URL');
    expect(html).not.toContain('Edit');
    expect(html).not.toContain('Retry');
  });
});

describe('StudioInspector — Image tab forwards actions (R3 PR4b)', () => {
  it('forwards selectedRowImageActions down to StudioInspectorImage', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow()}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="image"
        selectedRowImageState={{ status: 'idle' }}
        selectedRowImageActions={{
          onGenerate: () => {},
          onUpload: () => {},
          onImportUrl: () => {},
          canGenerate: true,
        }}
      />,
    );
    expect(html).toContain('Generate');
    expect(html).toContain('⬆ Upload');
    expect(html).toContain('🔗 Import URL');
  });
});

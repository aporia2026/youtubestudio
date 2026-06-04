/**
 * StudioInspectorVideo — read-only Video (B-roll) tab body.
 * Phase R3 PR4c of `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Also covers the StudioInspector tab routing that mounts the Video
 * body when `currentTab === 'video'` and a row is selected.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioInspectorVideo } from '@/components/production-doc/redesign/StudioInspectorVideo';
import { StudioInspector } from '@/components/production-doc/redesign/StudioInspector';
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

describe('StudioInspectorVideo — empty state', () => {
  it('renders the "no clip yet" prompt when clip is null', () => {
    const html = renderToStaticMarkup(<StudioInspectorVideo clip={null} />);
    expect(html).toContain('No B-roll clip has been generated for this row yet.');
  });

  it('renders the "no clip yet" prompt when clip is omitted', () => {
    const html = renderToStaticMarkup(<StudioInspectorVideo />);
    expect(html).toContain('No B-roll clip has been generated for this row yet.');
  });
});

describe('StudioInspectorVideo — status pill', () => {
  it.each([
    ['pending', 'Queued'],
    ['generating', 'Generating'],
    ['ready', 'Ready'],
    ['failed', 'Failed'],
  ] as const)('renders the documented label for status=%s', (status, expected) => {
    const html = renderToStaticMarkup(
      <StudioInspectorVideo
        clip={{
          status,
          videoUrl: undefined,
          durationSeconds: undefined,
        }}
      />,
    );
    expect(html).toContain(expected);
  });
});

describe('StudioInspectorVideo — clip preview', () => {
  it('mounts a <video> element with controls when the clip is ready and has a url', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorVideo
        clip={{
          status: 'ready',
          videoUrl: 'https://example.com/clip.mp4',
          durationSeconds: 5.2,
        }}
      />,
    );
    expect(html).toMatch(/<video[^>]*src="https:\/\/example\.com\/clip\.mp4"/);
    expect(html).toMatch(/<video[^>]*controls/);
    expect(html).toMatch(/aria-label="B-roll clip for the selected row"/);
  });

  it('omits the <video> element when status=ready but videoUrl is undefined', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorVideo
        clip={{
          status: 'ready',
          videoUrl: undefined,
          durationSeconds: undefined,
        }}
      />,
    );
    expect(html).not.toContain('<video');
  });

  it('does not show a <video> element while still generating', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorVideo
        clip={{
          status: 'generating',
          videoUrl: undefined,
          durationSeconds: undefined,
        }}
      />,
    );
    expect(html).not.toContain('<video');
  });
});

describe('StudioInspectorVideo — duration label', () => {
  it('shows the duration with one decimal when the clip is ready and duration is positive', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorVideo
        clip={{
          status: 'ready',
          videoUrl: 'https://x/y.mp4',
          durationSeconds: 5.234,
        }}
      />,
    );
    expect(html).toContain('5.2s');
  });

  it('omits the duration pill when durationSeconds is undefined', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorVideo
        clip={{
          status: 'ready',
          videoUrl: 'https://x/y.mp4',
        }}
      />,
    );
    expect(html).not.toMatch(/\d+\.\ds/);
  });

  it('omits the duration pill while still generating, even if duration is somehow set', () => {
    const html = renderToStaticMarkup(
      <StudioInspectorVideo
        clip={{
          status: 'generating',
          durationSeconds: 4,
        }}
      />,
    );
    expect(html).not.toContain('4.0s');
  });
});

describe('StudioInspectorVideo — unknown status (forward compatibility)', () => {
  it('falls back to the raw status string with a neutral pill (no crash)', () => {
    // page.tsx uses status: string — if a future B-roll provider adds a
    // new status ("processing", "queued_externally"), the inspector
    // shouldn't crash. It should pass the raw label through.
    const html = renderToStaticMarkup(
      <StudioInspectorVideo
        clip={{
          status: 'processing-stage-2',
        }}
      />,
    );
    expect(html).toContain('processing-stage-2');
  });
});

describe('StudioInspector — tab routing for Video (R3 PR4c)', () => {
  it('mounts StudioInspectorVideo when initialTab="video" and a row is selected', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow()}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="video"
        selectedRowVideoClip={{
          status: 'ready',
          videoUrl: 'https://example.com/clip.mp4',
          durationSeconds: 5,
        }}
      />,
    );
    expect(html).toContain('Ready');
    expect(html).toMatch(/<video[^>]*src="https:\/\/example\.com\/clip\.mp4"/);
    expect(html).not.toContain('lands in later R3 PRs');
  });

  it('shows the "no clip yet" prompt when row is selected, video tab, and no clip passed', () => {
    const html = renderToStaticMarkup(
      <StudioInspector
        selectedRow={makeRow()}
        selectedRowIndex={1}
        selectedRowLabel="0:00"
        initialTab="video"
      />,
    );
    expect(html).toContain('No B-roll clip has been generated for this row yet.');
  });
});

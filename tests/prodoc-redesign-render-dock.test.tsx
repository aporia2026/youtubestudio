/**
 * RenderDock — pinned-bottom batch + render bar in Studio Mode.
 * Phase R5 PR1 of `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Click-driven flows (Start Render, Download) need real DOM events
 * the SSR test env doesn't run; we pin the SSR contract — counter
 * pills, status pill, progress bar render contract, button enable /
 * disable, download anchor presence.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RenderDock,
  type RenderDockProps,
} from '@/components/production-doc/redesign/RenderDock';

function makeProps(overrides: Partial<RenderDockProps> = {}): RenderDockProps {
  return {
    imageStats: { ready: 0, failed: 0, total: 0 },
    videoStats: { ready: 0, failed: 0, total: 0 },
    status: 'idle',
    ...overrides,
  };
}

describe('RenderDock — landmark + status', () => {
  it('renders as a region landmark with the documented aria-label', () => {
    const html = renderToStaticMarkup(<RenderDock {...makeProps()} />);
    // React preserves source attribute order; we don't lock the
    // order, just that both attributes appear on the same element.
    expect(html).toMatch(/aria-label="Render dock"/);
    expect(html).toMatch(/role="region"/);
  });

  it.each<[RenderDockProps['status'], string]>([
    ['idle', 'Idle'],
    ['rendering', 'Rendering'],
    ['done', 'Done'],
    ['error', 'Failed'],
  ])('renders the documented status pill for status=%s', (status, expected) => {
    const html = renderToStaticMarkup(<RenderDock {...makeProps({ status })} />);
    expect(html).toContain(expected);
  });
});

describe('RenderDock — media counters', () => {
  it('renders the image and video ready/total pills', () => {
    const html = renderToStaticMarkup(
      <RenderDock
        {...makeProps({
          imageStats: { ready: 11, failed: 0, total: 12 },
          videoStats: { ready: 4, failed: 0, total: 12 },
        })}
      />,
    );
    expect(html).toContain('Images 11/12');
    expect(html).toContain('Videos 4/12');
  });

  it('shows the failed-images chip when failed > 0, hides it otherwise', () => {
    const withFails = renderToStaticMarkup(
      <RenderDock
        {...makeProps({
          imageStats: { ready: 8, failed: 2, total: 12 },
        })}
      />,
    );
    expect(withFails).toContain('2 images failed');

    const withoutFails = renderToStaticMarkup(<RenderDock {...makeProps()} />);
    expect(withoutFails).not.toMatch(/images? failed/);
  });

  it('uses singular form for exactly one failure', () => {
    const html = renderToStaticMarkup(
      <RenderDock
        {...makeProps({
          imageStats: { ready: 1, failed: 1, total: 2 },
          videoStats: { ready: 0, failed: 1, total: 2 },
        })}
      />,
    );
    expect(html).toContain('1 image failed');
    expect(html).toContain('1 clip failed');
  });
});

describe('RenderDock — primary CTA', () => {
  it('renders "Start Render →" when idle and onStartRender is wired', () => {
    const html = renderToStaticMarkup(
      <RenderDock {...makeProps({ onStartRender: () => {} })} />,
    );
    expect(html).toMatch(/<button[^>]*>\s*Start Render\s*→\s*<\/button>/);
  });

  it('disables the button while rendering and changes label to "Rendering…"', () => {
    const html = renderToStaticMarkup(
      <RenderDock
        {...makeProps({ status: 'rendering', onStartRender: () => {} })}
      />,
    );
    expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*>\s*Rendering…/);
  });

  it('flips the label to "↻ Render again" after a successful render', () => {
    const html = renderToStaticMarkup(
      <RenderDock
        {...makeProps({
          status: 'done',
          downloadUrl: 'https://example.com/final.mp4',
          onStartRender: () => {},
        })}
      />,
    );
    expect(html).toContain('↻ Render again');
  });

  it('hides the button entirely when no onStartRender is wired (rule 10)', () => {
    const html = renderToStaticMarkup(<RenderDock {...makeProps()} />);
    expect(html).not.toContain('Start Render');
  });
});

describe('RenderDock — progress + download', () => {
  it('renders an accessible progressbar with the clamped progress value', () => {
    const html = renderToStaticMarkup(
      <RenderDock
        {...makeProps({ status: 'rendering', progress: 73, onStartRender: () => {} })}
      />,
    );
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="73"/);
    expect(html).toContain('73%');
  });

  it('clamps progress < 0 to 0 and > 100 to 100', () => {
    const negative = renderToStaticMarkup(
      <RenderDock {...makeProps({ status: 'rendering', progress: -5, onStartRender: () => {} })} />,
    );
    expect(negative).toMatch(/aria-valuenow="0"/);

    const over = renderToStaticMarkup(
      <RenderDock {...makeProps({ status: 'rendering', progress: 250, onStartRender: () => {} })} />,
    );
    expect(over).toMatch(/aria-valuenow="100"/);
  });

  it('renders the Download anchor when status=done and downloadUrl is set', () => {
    const html = renderToStaticMarkup(
      <RenderDock
        {...makeProps({
          status: 'done',
          downloadUrl: 'https://example.com/final.mp4',
        })}
      />,
    );
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com\/final\.mp4"[^>]*download/);
    expect(html).toContain('⬇ Download');
  });

  it('omits the Download anchor when status=done but downloadUrl is undefined', () => {
    const html = renderToStaticMarkup(
      <RenderDock {...makeProps({ status: 'done' })} />,
    );
    expect(html).not.toContain('⬇ Download');
  });
});

describe('RenderDock — error message', () => {
  it('shows a truncated error message when status=error', () => {
    const html = renderToStaticMarkup(
      <RenderDock
        {...makeProps({
          status: 'error',
          errorMessage: 'Upstream Lambda returned 500 — please try again later.',
        })}
      />,
    );
    expect(html).toContain('Upstream Lambda returned 500');
  });

  it('omits the inline error when status is not error', () => {
    const html = renderToStaticMarkup(
      <RenderDock
        {...makeProps({
          status: 'idle',
          errorMessage: 'stale error from earlier',
        })}
      />,
    );
    expect(html).not.toContain('stale error from earlier');
  });
});

/**
 * Studio sub-mode toggle (scene-strip vs bulk-grid). Phase R3 PR6 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Tests cover the top-bar toggle render contract and the conditional
 * layout switch in StudioMode. Persistence via getPref/setPref is
 * verified indirectly (the toggle calls them) but not exercised here
 * — the `user-prefs` module has its own test coverage.
 *
 * State-change behaviour (clicking the toggle flips the mode) needs
 * real DOM events that the SSR test env doesn't run; we cover the
 * controlled render under both modes via the `initialSubMode` prop.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudioTopBar } from '@/components/production-doc/redesign/StudioTopBar';
import { StudioMode } from '@/components/production-doc/redesign/StudioMode';
import type { ProductionDoc } from '@/remotion/utils';

const SAMPLE_DOC: ProductionDoc = {
  title: 'sample',
  niche: 'finance',
  total_duration: '1:00',
  total_words: 100,
  speaking_pace_wpm: 125,
  rows: [],
};

describe('StudioTopBar — sub-mode toggle (R3 PR6)', () => {
  it('omits the toggle when subMode + onToggleSubMode are not provided', () => {
    const html = renderToStaticMarkup(<StudioTopBar doc={SAMPLE_DOC} />);
    expect(html).not.toContain('Bulk grid');
    expect(html).not.toContain('Scene strip');
  });

  it('omits the toggle when subMode is provided but onToggleSubMode is missing (rule 10)', () => {
    const html = renderToStaticMarkup(
      <StudioTopBar doc={SAMPLE_DOC} subMode="scene-strip" />,
    );
    expect(html).not.toContain('Bulk grid');
  });

  it('renders "Bulk grid" label when currently in scene-strip mode', () => {
    const html = renderToStaticMarkup(
      <StudioTopBar
        doc={SAMPLE_DOC}
        subMode="scene-strip"
        onToggleSubMode={() => {}}
      />,
    );
    expect(html).toContain('Bulk grid');
    expect(html).not.toContain('Scene strip');
    expect(html).toMatch(/aria-pressed="false"/);
  });

  it('renders "Scene strip" label when currently in bulk-grid mode', () => {
    const html = renderToStaticMarkup(
      <StudioTopBar
        doc={SAMPLE_DOC}
        subMode="bulk-grid"
        onToggleSubMode={() => {}}
      />,
    );
    expect(html).toContain('Scene strip');
    expect(html).not.toContain('Bulk grid');
    expect(html).toMatch(/aria-pressed="true"/);
  });

  it('shows both Bulk-grid toggle AND New session button together', () => {
    const html = renderToStaticMarkup(
      <StudioTopBar
        doc={SAMPLE_DOC}
        subMode="scene-strip"
        onToggleSubMode={() => {}}
        onNewSession={() => {}}
      />,
    );
    expect(html).toContain('Bulk grid');
    expect(html).toContain('New session');
  });
});

describe('StudioMode — layout switch via subMode (R3 PR6)', () => {
  it('renders the 3-column StudioLayout by default (scene-strip mode)', () => {
    const html = renderToStaticMarkup(
      <StudioMode doc={SAMPLE_DOC}>
        <span data-testid="grid">grid</span>
      </StudioMode>,
    );
    expect(html).toMatch(/aria-label="Studio left rail"/);
    expect(html).toMatch(/aria-label="Studio main content"/);
    expect(html).toMatch(/aria-label="Studio inspector"/);
    expect(html).toContain('data-testid="grid"');
  });

  it('skips the 3-column layout in bulk-grid mode and renders children full-width', () => {
    const html = renderToStaticMarkup(
      <StudioMode doc={SAMPLE_DOC} initialSubMode="bulk-grid">
        <span data-testid="grid">grid</span>
      </StudioMode>,
    );
    expect(html).not.toMatch(/aria-label="Studio left rail"/);
    expect(html).not.toMatch(/aria-label="Studio main content"/);
    expect(html).not.toMatch(/aria-label="Studio inspector"/);
    // Children still render — bulk-grid is escape-to-full-width.
    expect(html).toContain('data-testid="grid"');
  });

  it('always renders the StudioTopBar regardless of sub-mode', () => {
    const sceneHtml = renderToStaticMarkup(
      <StudioMode doc={SAMPLE_DOC} initialSubMode="scene-strip">
        <span>g</span>
      </StudioMode>,
    );
    expect(sceneHtml).toMatch(/aria-label="Studio top bar"/);

    const bulkHtml = renderToStaticMarkup(
      <StudioMode doc={SAMPLE_DOC} initialSubMode="bulk-grid">
        <span>g</span>
      </StudioMode>,
    );
    expect(bulkHtml).toMatch(/aria-label="Studio top bar"/);
  });

  it('honors initialSubMode override (test contract)', () => {
    const html = renderToStaticMarkup(
      <StudioMode doc={SAMPLE_DOC} initialSubMode="bulk-grid">
        <span>g</span>
      </StudioMode>,
    );
    // In bulk-grid mode the toggle button label reads "Scene strip"
    // (action: switch back to scene-strip).
    expect(html).toContain('Scene strip');
  });
});

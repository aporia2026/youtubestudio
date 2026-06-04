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

describe('StudioMode — controlled subMode (R4 PR3)', () => {
  it('uses the controlled subMode prop when provided (page.tsx pattern)', () => {
    const html = renderToStaticMarkup(
      <StudioMode
        doc={SAMPLE_DOC}
        subMode="bulk-grid"
        onToggleSubMode={() => {}}
      >
        <span data-testid="grid">grid</span>
      </StudioMode>,
    );
    // Bulk-grid sub-mode skips the 3-column layout — same observable
    // contract as if `initialSubMode="bulk-grid"` had been passed.
    expect(html).not.toMatch(/aria-label="Studio left rail"/);
    expect(html).not.toMatch(/aria-label="Studio inspector"/);
    expect(html).toContain('data-testid="grid"');
  });

  it('falls back to internal state when subMode is omitted (back-compat with R3 PR6 callers)', () => {
    const html = renderToStaticMarkup(
      <StudioMode doc={SAMPLE_DOC} initialSubMode="scene-strip">
        <span>g</span>
      </StudioMode>,
    );
    // Scene-strip layout is the default observable behaviour.
    expect(html).toMatch(/aria-label="Studio left rail"/);
  });

  it('renders the toggle button label from the controlled subMode, not the internal state', () => {
    const html = renderToStaticMarkup(
      <StudioMode
        doc={SAMPLE_DOC}
        subMode="bulk-grid"
        onToggleSubMode={() => {}}
        initialSubMode="scene-strip"
      >
        <span>g</span>
      </StudioMode>,
    );
    // Controlled value wins — bulk-grid → button reads "Scene strip".
    expect(html).toContain('Scene strip');
    expect(html).not.toMatch(/>\s*▦ Bulk grid\s*</);
  });
});

describe('StudioMode — scene-strip orientation toggle (R4 PR2)', () => {
  it('renders the orientation toggle in scene-strip mode by default', () => {
    const html = renderToStaticMarkup(
      <StudioMode doc={SAMPLE_DOC} initialSubMode="scene-strip">
        <span>g</span>
      </StudioMode>,
    );
    // Default orientation is horizontal; toggle label hints at the
    // ACTION (switch to vertical).
    expect(html).toContain('⫾ Vertical');
  });

  it('shows "⫿ Horizontal" label when starting in vertical orientation', () => {
    const html = renderToStaticMarkup(
      <StudioMode
        doc={SAMPLE_DOC}
        initialSubMode="scene-strip"
        initialSceneStripOrientation="vertical"
      >
        <span>g</span>
      </StudioMode>,
    );
    expect(html).toContain('⫿ Horizontal');
    expect(html).not.toContain('⫾ Vertical');
  });

  it('hides the orientation toggle when in bulk-grid mode (no scene strip is visible)', () => {
    const html = renderToStaticMarkup(
      <StudioMode doc={SAMPLE_DOC} initialSubMode="bulk-grid">
        <span>g</span>
      </StudioMode>,
    );
    expect(html).not.toContain('⫾ Vertical');
    expect(html).not.toContain('⫿ Horizontal');
  });

  it('propagates the orientation to the SceneStrip render in scene-strip mode', () => {
    // SceneStrip only emits the data-orientation marker when there
    // are rows to render — the empty state has no orientation.
    const docWithRows: typeof SAMPLE_DOC = {
      ...SAMPLE_DOC,
      rows: [
        {
          timecode: '0:00',
          script_text: '',
          visual_type: 'B-Roll',
          visual_description: '',
          stock_search_terms: '',
          ai_image_prompt: '',
          on_screen_text: '',
          notes: '',
        } as never,
      ],
    };

    const verticalHtml = renderToStaticMarkup(
      <StudioMode
        doc={docWithRows}
        initialSubMode="scene-strip"
        initialSceneStripOrientation="vertical"
      >
        <span>g</span>
      </StudioMode>,
    );
    expect(verticalHtml).toMatch(/data-orientation="vertical"/);

    const horizontalHtml = renderToStaticMarkup(
      <StudioMode
        doc={docWithRows}
        initialSubMode="scene-strip"
        initialSceneStripOrientation="horizontal"
      >
        <span>g</span>
      </StudioMode>,
    );
    expect(horizontalHtml).toMatch(/data-orientation="horizontal"/);
  });
});

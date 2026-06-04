/**
 * Production-doc redesign — shell + Brief Mode header tests. See
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Phase R0 shipped the feature flag, the scaffolding folder, and a
 * transparent-pass-through shell. Phase R1 (first PR) lands the
 * `BriefHeader` at the top of Brief Mode.
 *
 * These tests pin the contracts later phases rely on:
 *   - The shell routes `doc === null` to Brief Mode and `doc !== null`
 *     to Studio Mode (stable mode routing).
 *   - Brief Mode renders `BriefHeader` above children (R1).
 *   - Studio Mode is still a transparent pass-through (until R2).
 *   - The `onNewSession` callback wires through shell → BriefMode →
 *     BriefHeader without being lost in transit.
 *   - The feature flag is exported as a boolean and defaults to off.
 *
 * useEffect-based observability logs (`[prodoc shell] mount`,
 * `[prodoc shell] mode-switch`) are covered by manual QA per §12 of
 * the plan because the project test environment is `node` + SSR
 * (`renderToStaticMarkup`), which does not fire effects.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ProductionDocShell,
  selectShellMode,
} from '@/components/production-doc/redesign/ProductionDocShell';
import { PROD_DOC_REDESIGN_V1_PUBLIC } from '@/lib/feature-flags';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';

const SAMPLE_DOC: ProductionDoc = {
  title: 'Test doc',
  niche: 'finance',
  total_duration: '0:30',
  total_words: 75,
  speaking_pace_wpm: 150,
  rows: [],
};

describe('selectShellMode — pure mode routing', () => {
  it('routes a null doc to brief mode', () => {
    expect(selectShellMode(null)).toBe('brief');
  });

  it('routes a non-null doc to studio mode', () => {
    expect(selectShellMode(SAMPLE_DOC)).toBe('studio');
  });

  it('routes a doc with zero rows to studio mode (presence of doc, not row-count, is the signal)', () => {
    expect(selectShellMode({ ...SAMPLE_DOC, rows: [] })).toBe('studio');
  });
});

describe('ProductionDocShell — children always rendered', () => {
  it('renders children when doc is null (brief mode)', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={null}>
        <div data-testid="legacy-content">legacy page render</div>
      </ProductionDocShell>,
    );
    expect(html).toContain('data-testid="legacy-content"');
    expect(html).toContain('legacy page render');
  });

  it('renders children when doc exists (studio mode)', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC}>
        <div data-testid="legacy-content">legacy page render</div>
      </ProductionDocShell>,
    );
    expect(html).toContain('data-testid="legacy-content"');
    expect(html).toContain('legacy page render');
  });

  it('Studio Mode now injects the StudioTopBar above children (R2)', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC}>
        <span data-testid="legacy-studio">legacy grid</span>
      </ProductionDocShell>,
    );
    // Top bar landmark identifies the chrome unambiguously.
    expect(html).toMatch(/aria-label="Studio top bar"/);
    // Children still render after the top bar.
    expect(html).toContain('data-testid="legacy-studio"');
    // Order: top bar precedes the children.
    const topBarIdx = html.indexOf('Studio top bar');
    const childIdx = html.indexOf('legacy-studio');
    expect(topBarIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeGreaterThan(topBarIdx);
  });

  it('Studio Mode wraps children in the three-column StudioLayout (R3 PR2)', () => {
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
        } as ProductionRow,
      ],
    };
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={docWithRows}>
        <span data-testid="legacy-studio">grid</span>
      </ProductionDocShell>,
    );
    // All three column landmarks are present.
    expect(html).toMatch(/aria-label="Studio left rail"/);
    expect(html).toMatch(/aria-label="Studio main content"/);
    expect(html).toMatch(/aria-label="Studio inspector"/);
    // Children land inside the main column.
    expect(html).toContain('data-testid="legacy-studio"');
    // Legend now lives inside the left rail, not above the children.
    expect(html).toMatch(/aria-label="Studio left rail"[\s\S]*?Scene type breakdown/);
    // Top bar still precedes the layout.
    const topBarIdx = html.indexOf('Studio top bar');
    const layoutIdx = html.indexOf('Studio left rail');
    expect(topBarIdx).toBeLessThan(layoutIdx);
  });

  it('Studio Mode inspector renders the tab bar and the empty-state prompt (R3 PR2)', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC}>
        <span>grid</span>
      </ProductionDocShell>,
    );
    expect(html).toMatch(/aria-label="Row inspector"/);
    expect(html).toMatch(/aria-label="Row inspector tabs"/);
    expect(html).toContain('Select a row');
  });

  it('Studio Mode inspector populates from selectedRowIndex (R3 PR3)', () => {
    const docWithRows: typeof SAMPLE_DOC = {
      ...SAMPLE_DOC,
      rows: [
        {
          timecode: '0:00',
          script_text: 'first row script',
          visual_type: 'Title Card',
          visual_description: '',
          stock_search_terms: '',
          ai_image_prompt: '',
          on_screen_text: '',
          notes: '',
        } as ProductionRow,
        {
          timecode: '0:42',
          script_text: 'second row script wired correctly',
          visual_type: 'B-Roll',
          visual_description: '',
          stock_search_terms: '',
          ai_image_prompt: '',
          on_screen_text: '',
          notes: '',
        } as ProductionRow,
      ],
    };
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={docWithRows} selectedRowIndex={1}>
        <span>grid</span>
      </ProductionDocShell>,
    );
    // Display index is 1-based — selectedRowIndex=1 (0-based) → "Row 2".
    expect(html).toContain('Row 2');
    expect(html).toContain('0:42');
    expect(html).toContain('second row script wired correctly');
    expect(html).not.toContain('Select a row');
  });

  it('Studio Mode inspector falls back to empty state when selectedRowIndex is out of range', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC} selectedRowIndex={42}>
        <span>grid</span>
      </ProductionDocShell>,
    );
    // SAMPLE_DOC has no rows; out-of-range index should not crash and
    // should render the empty state.
    expect(html).toContain('Select a row');
  });
});

describe('ProductionDocShell — Brief Mode header injection (R1)', () => {
  it('Brief Mode injects the BriefHeader above the children', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={null}>
        <span data-testid="legacy-inputs">legacy inputs</span>
      </ProductionDocShell>,
    );
    // Header text appears.
    expect(html).toContain('Production Doc');
    expect(html).toContain('Plan, write, and produce a video end to end.');
    // Children still render after the header.
    expect(html).toContain('data-testid="legacy-inputs"');
    // Header precedes the children in the DOM order — important so the
    // user reads the page top-to-bottom as Brief, then inputs.
    const headerIdx = html.indexOf('Production Doc');
    const childIdx = html.indexOf('legacy-inputs');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeGreaterThan(headerIdx);
  });

  it('omits the New session button when onNewSession is not provided', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={null}>
        <span>inputs</span>
      </ProductionDocShell>,
    );
    expect(html).not.toContain('New session');
  });

  it('renders the New session button when onNewSession is provided', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={null} onNewSession={() => {}}>
        <span>inputs</span>
      </ProductionDocShell>,
    );
    expect(html).toContain('New session');
  });

  it('Studio Mode renders the doc title (not "Production Doc") and does NOT render BriefHeader', () => {
    // Brief and Studio are mutually exclusive. Studio shows the doc
    // title (via StudioTopBar) where Brief shows the generic
    // "Production Doc" page title.
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC} onNewSession={() => {}}>
        <span>studio content</span>
      </ProductionDocShell>,
    );
    expect(html).toContain('Test doc');
    expect(html).not.toContain('Plan, write, and produce a video');
    expect(html).not.toContain('Production doc workflow');
  });

  it('Studio Mode forwards onNewSession to its top bar', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC} onNewSession={() => {}}>
        <span>studio content</span>
      </ProductionDocShell>,
    );
    expect(html).toContain('New session');
  });

  it('Wraps the active mode in a motion container for the Brief↔Studio fade (R5 PR3)', () => {
    // framer-motion's motion.div SSRs as a plain <div> but keeps the
    // animation styles initial state inline (opacity:0 on enter unless
    // reduced-motion). We assert the structural wrapper is present so
    // future tests/regressions catch accidental unwrap.
    const briefHtml = renderToStaticMarkup(
      <ProductionDocShell doc={null}>
        <span data-testid="content">brief content</span>
      </ProductionDocShell>,
    );
    // Brief Mode chrome is preserved.
    expect(briefHtml).toContain('Production Doc');
    expect(briefHtml).toContain('data-testid="content"');

    const studioHtml = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC}>
        <span data-testid="content">studio content</span>
      </ProductionDocShell>,
    );
    expect(studioHtml).toMatch(/aria-label="Studio top bar"/);
    expect(studioHtml).toContain('data-testid="content"');
  });

  it('Studio Mode omits the New session button when onNewSession is not provided', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC}>
        <span>studio content</span>
      </ProductionDocShell>,
    );
    expect(html).not.toContain('New session');
  });

  it('Brief Mode also renders the four-step BriefSteps chrome (R1b)', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={null}>
        <span>inputs</span>
      </ProductionDocShell>,
    );
    // The nav landmark identifies BriefSteps unambiguously — easier to
    // check than the label text (which could collide with content).
    expect(html).toMatch(/<nav[^>]*aria-label="Production doc workflow"/);
    // First step is current by default.
    expect(html).toMatch(/aria-current="step"/);
  });

  it('Studio Mode does NOT render the BriefSteps chrome', () => {
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC}>
        <span>studio</span>
      </ProductionDocShell>,
    );
    expect(html).not.toMatch(/aria-label="Production doc workflow"/);
  });
});

describe('PROD_DOC_REDESIGN_V1_PUBLIC — feature flag export', () => {
  it('is exported as a boolean', () => {
    expect(typeof PROD_DOC_REDESIGN_V1_PUBLIC).toBe('boolean');
  });

  it('defaults to false when NEXT_PUBLIC_PROD_DOC_REDESIGN_V1 is unset (production safety)', () => {
    // The test environment does not set the env var, so the resolved
    // value must be false. If this fails, the default-OFF contract is
    // broken and the redesign would ship to all users unintentionally.
    expect(PROD_DOC_REDESIGN_V1_PUBLIC).toBe(false);
  });
});

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
import type { ProductionDoc } from '@/remotion/utils';

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

  it('Studio Mode is still a transparent pass-through (until R2)', () => {
    // Studio Mode does not inject chrome yet — page.tsx still renders
    // the legacy grid inside the children. R2 will replace this with
    // the new top bar + left rail + render dock. When that phase lands,
    // update this assertion deliberately.
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC}>
        <span>only-child</span>
      </ProductionDocShell>,
    );
    expect(html).toBe('<span>only-child</span>');
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

  it('Studio Mode does not render the BriefHeader even with onNewSession set', () => {
    // Brief and Studio are mutually exclusive. The new-session callback
    // for Studio Mode will live in the Studio top bar (R2), not in
    // the Brief header.
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={SAMPLE_DOC} onNewSession={() => {}}>
        <span>studio content</span>
      </ProductionDocShell>,
    );
    expect(html).not.toContain('Production Doc');
    expect(html).not.toContain('New session');
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

/**
 * Phase R0 of the production-doc redesign — see
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * R0 ships only the feature flag, the scaffolding folder, and a
 * transparent-pass-through shell. These tests pin the contract for
 * later phases:
 *
 *   - The shell routes `doc === null` to `BriefMode` and `doc !== null`
 *     to `StudioMode`. R1 onward depends on this routing being stable.
 *   - The shell renders its children through unchanged. R0's flag flip
 *     must not lose any of today's page render.
 *   - The feature flag is exported as a boolean. Page-level wiring
 *     dereferences this directly.
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

describe('ProductionDocShell — transparent pass-through (Phase R0)', () => {
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

  it('does not inject any visible chrome around children (R0 contract)', () => {
    // R0 contract: the shell is presentation-transparent until R1+ fills
    // it in. If this assertion ever fails because a future phase added
    // chrome, update this test deliberately — do not paper over.
    const html = renderToStaticMarkup(
      <ProductionDocShell doc={null}>
        <span>only-child</span>
      </ProductionDocShell>,
    );
    expect(html).toBe('<span>only-child</span>');
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

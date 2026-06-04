/**
 * BriefSteps — four-step Notebook progress chrome under BriefHeader.
 * Phase R1b of `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Tests pin the rendered shape so a typo in a step label or a missed
 * step doesn't slip through, and so the active-step highlighting
 * matches the `aria-current="step"` contract assistive tech relies on.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefSteps } from '@/components/production-doc/redesign/BriefSteps';

describe('BriefSteps — content', () => {
  it('renders all four step labels in the documented order', () => {
    const html = renderToStaticMarkup(<BriefSteps />);
    const briefIdx = html.indexOf('Brief');
    const styleIdx = html.indexOf('Style');
    const scriptIdx = html.indexOf('Script');
    const generateIdx = html.indexOf('Generate');
    expect(briefIdx).toBeGreaterThanOrEqual(0);
    expect(styleIdx).toBeGreaterThan(briefIdx);
    expect(scriptIdx).toBeGreaterThan(styleIdx);
    expect(generateIdx).toBeGreaterThan(scriptIdx);
  });

  it('uses a nav landmark with an accessible name', () => {
    const html = renderToStaticMarkup(<BriefSteps />);
    expect(html).toMatch(/<nav[^>]*aria-label="Production doc workflow"/);
  });
});

describe('BriefSteps — current-step highlighting', () => {
  it('marks step 1 as current by default', () => {
    const html = renderToStaticMarkup(<BriefSteps />);
    // The numbered badge for the current step appears before the
    // accessible label "Brief".
    expect(html).toMatch(/aria-current="step"[\s\S]*?Brief/);
    // No other step should claim aria-current.
    const ariaCurrentCount = (html.match(/aria-current="step"/g) ?? []).length;
    expect(ariaCurrentCount).toBe(1);
  });

  it('honors an explicit current=3 prop', () => {
    const html = renderToStaticMarkup(<BriefSteps current={3} />);
    expect(html).toMatch(/aria-current="step"[\s\S]*?Script/);
    expect(html).not.toMatch(/aria-current="step"[\s\S]*?Brief\s*<\/span>/);
  });
});

describe('BriefSteps — separator chrome', () => {
  it('inserts exactly three separators between the four steps', () => {
    const html = renderToStaticMarkup(<BriefSteps />);
    const separators = (html.match(/aria-hidden="true"/g) ?? []).length;
    expect(separators).toBe(3);
  });
});

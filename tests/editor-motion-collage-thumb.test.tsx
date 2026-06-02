/**
 * Unit tests for <MotionCollageThumb>.
 *
 * Branch coverage:
 *   1. panelUrls.length > 1 → renders N <img> in a CSS grid sized by the
 *      passed `grid` prop.
 *   2. panelUrls.length > 1 with no `grid` prop → derives a square-ish layout
 *      (ceil(sqrt(N)) cols, ceil(N / cols) rows).
 *   3. panelUrls.length === 1 → renders a single <img> of that panel,
 *      ignoring fallbackImageUrl.
 *   4. panelUrls undefined / empty → falls back to fallbackImageUrl.
 *   5. nothing renderable → returns null (caller owns the blank state).
 *   6. fillParent prop → root uses absolute positioning.
 *
 * Regression: covers the bug where motion-collage shots disguised
 * themselves as single static thumbnails in the editor left rail and
 * timeline. See `_plans/2026-06-02-editor-motion-collage-support.md`
 * PR 1.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotionCollageThumb } from '@/components/editor/MotionCollageThumb';

describe('MotionCollageThumb — panel grid (regression for editor motion-collage blindness)', () => {
  it('renders 4 panels in a 2×2 CSS grid when grid={cols:2,rows:2}', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={['a.png', 'b.png', 'c.png', 'd.png']}
        grid={{ cols: 2, rows: 2 }}
        fallbackImageUrl={null}
      />,
    );
    expect(html).toMatch(/grid-template-columns:repeat\(2,\s*1fr\)/);
    expect(html).toMatch(/grid-template-rows:repeat\(2,\s*1fr\)/);
    expect(html).toMatch(/<img[^>]*src="a\.png"/);
    expect(html).toMatch(/<img[^>]*src="b\.png"/);
    expect(html).toMatch(/<img[^>]*src="c\.png"/);
    expect(html).toMatch(/<img[^>]*src="d\.png"/);
    expect(html).toContain('aria-label="Motion collage with 4 keyframes"');
  });

  it('honors non-square grids like 3×2 instead of falling back to a square-ish guess', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png']}
        grid={{ cols: 3, rows: 2 }}
        fallbackImageUrl={null}
      />,
    );
    expect(html).toMatch(/grid-template-columns:repeat\(3,\s*1fr\)/);
    expect(html).toMatch(/grid-template-rows:repeat\(2,\s*1fr\)/);
  });

  it('derives a square-ish grid when no grid prop is passed (9 panels → 3×3)', () => {
    const panels = Array.from({ length: 9 }, (_, i) => `p${i}.png`);
    const html = renderToStaticMarkup(
      <MotionCollageThumb panelUrls={panels} fallbackImageUrl={null} />,
    );
    expect(html).toMatch(/grid-template-columns:repeat\(3,\s*1fr\)/);
    expect(html).toMatch(/grid-template-rows:repeat\(3,\s*1fr\)/);
  });

  it('derives a square-ish grid for non-perfect-square N (6 → 3×2)', () => {
    const panels = Array.from({ length: 6 }, (_, i) => `p${i}.png`);
    const html = renderToStaticMarkup(
      <MotionCollageThumb panelUrls={panels} fallbackImageUrl={null} />,
    );
    expect(html).toMatch(/grid-template-columns:repeat\(3,\s*1fr\)/);
    expect(html).toMatch(/grid-template-rows:repeat\(2,\s*1fr\)/);
  });
});

describe('MotionCollageThumb — single image fallback', () => {
  it('renders single image when only one panel is provided (no grid)', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={['only.png']}
        fallbackImageUrl="ignored.png"
      />,
    );
    // Single <img>, no grid container.
    expect(html).toMatch(/<img[^>]*src="only\.png"/);
    expect(html).not.toContain('ignored.png');
    expect(html).not.toContain('grid-template-columns');
  });

  it('renders fallbackImageUrl when panelUrls is undefined', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={undefined}
        fallbackImageUrl="https://example.com/regular.png"
      />,
    );
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/regular\.png"/);
    expect(html).not.toContain('grid-template-columns');
  });

  it('renders fallbackImageUrl when panelUrls is empty', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={[]}
        fallbackImageUrl="fallback.png"
      />,
    );
    expect(html).toMatch(/<img[^>]*src="fallback\.png"/);
  });
});

describe('MotionCollageThumb — empty state', () => {
  it('returns null when neither panels nor fallback are renderable', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={undefined}
        fallbackImageUrl={null}
      />,
    );
    // renderToStaticMarkup returns '' for a null component result.
    expect(html).toBe('');
  });

  it('returns null when panels is empty AND fallback is undefined', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={[]}
        fallbackImageUrl={undefined}
      />,
    );
    expect(html).toBe('');
  });
});

describe('MotionCollageThumb — layout knobs', () => {
  it('applies absolute positioning when fillParent is true', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={['x.png']}
        fallbackImageUrl={null}
        fillParent
      />,
    );
    expect(html).toContain('position:absolute');
    expect(html).toContain('inset:0');
  });

  it('uses width/height 100% when fillParent is false', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={['x.png']}
        fallbackImageUrl={null}
        fillParent={false}
      />,
    );
    expect(html).toContain('width:100%');
    expect(html).toContain('height:100%');
  });

  it('passes loading attribute through to img elements', () => {
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={['a.png', 'b.png', 'c.png', 'd.png']}
        grid={{ cols: 2, rows: 2 }}
        fallbackImageUrl={null}
        loading="eager"
      />,
    );
    expect(html).toMatch(/loading="eager"/);
  });

  it('caps visible panels at grid.cols * grid.rows even when panelUrls.length exceeds it', () => {
    // Defensive: if the server returns more panel URLs than the grid
    // allocates, the thumbnail must NOT overflow the grid.
    const panels = Array.from({ length: 9 }, (_, i) => `p${i}.png`);
    const html = renderToStaticMarkup(
      <MotionCollageThumb
        panelUrls={panels}
        grid={{ cols: 2, rows: 2 }}
        fallbackImageUrl={null}
      />,
    );
    // Should render 4 imgs (capped at 2×2), not 9.
    const imgCount = (html.match(/<img/g) ?? []).length;
    expect(imgCount).toBe(4);
  });
});

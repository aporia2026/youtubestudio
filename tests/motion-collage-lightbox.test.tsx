/**
 * Unit tests for <MotionCollageLightbox>.
 *
 * Covers the grid view rendering, single-panel zoom rendering, and
 * the title-bar metadata. Keyboard handling (Esc, arrows, G) is wired
 * via window.addEventListener inside a useEffect — not exercised in
 * SSR; covered by manual QA on a real doc.
 *
 * PR 3 of `_plans/2026-06-02-editor-motion-collage-support.md`.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotionCollageLightbox } from '@/components/editor/MotionCollageLightbox';

describe('MotionCollageLightbox — grid view (default)', () => {
  it('renders every panel as a clickable cell in the row\'s grid layout', () => {
    const panelUrls = ['a.png', 'b.png', 'c.png', 'd.png'];
    const html = renderToStaticMarkup(
      <MotionCollageLightbox
        panelUrls={panelUrls}
        grid={{ cols: 2, rows: 2 }}
        shotIndex={1}
        onClose={() => {}}
      />,
    );
    expect(html).toMatch(/grid-template-columns:repeat\(2,\s*1fr\)/);
    expect(html).toMatch(/grid-template-rows:repeat\(2,\s*1fr\)/);
    for (const url of panelUrls) {
      expect(html).toContain(`src="${url}"`);
    }
  });

  it('shows the ordinal badge on each panel cell', () => {
    const panelUrls = ['a.png', 'b.png', 'c.png', 'd.png'];
    const html = renderToStaticMarkup(
      <MotionCollageLightbox
        panelUrls={panelUrls}
        grid={{ cols: 2, rows: 2 }}
        shotIndex={0}
        onClose={() => {}}
      />,
    );
    // Each panel has an ordinal badge with its 1-indexed number.
    expect(html).toContain('>1</span>');
    expect(html).toContain('>2</span>');
    expect(html).toContain('>3</span>');
    expect(html).toContain('>4</span>');
  });

  it('shows title bar with the correct shot ordinal and panel count', () => {
    const html = renderToStaticMarkup(
      <MotionCollageLightbox
        panelUrls={['a.png', 'b.png', 'c.png', 'd.png']}
        grid={{ cols: 2, rows: 2 }}
        shotIndex={4} // displayed as Shot 5
        onClose={() => {}}
      />,
    );
    expect(html).toContain('Shot 5');
    expect(html).toContain('2×2');
    expect(html).toContain('4 panels');
  });

  it('derives a square-ish grid when no grid prop is given', () => {
    const panelUrls = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'];
    const html = renderToStaticMarkup(
      <MotionCollageLightbox
        panelUrls={panelUrls}
        shotIndex={0}
        onClose={() => {}}
      />,
    );
    // 6 panels → square-ish 3×2.
    expect(html).toMatch(/grid-template-columns:repeat\(3,\s*1fr\)/);
    expect(html).toMatch(/grid-template-rows:repeat\(2,\s*1fr\)/);
  });

  it('caps visible panels at grid.cols * grid.rows', () => {
    const panelUrls = Array.from({ length: 9 }, (_, i) => `p${i}.png`);
    const html = renderToStaticMarkup(
      <MotionCollageLightbox
        panelUrls={panelUrls}
        grid={{ cols: 2, rows: 2 }}
        shotIndex={0}
        onClose={() => {}}
      />,
    );
    // 4 img tags inside the grid (one ordinal-badge span per cell, plus
    // close-icon spans). Count actual <img> tags via a fixed regex.
    const imgCount = (html.match(/<img/g) ?? []).length;
    expect(imgCount).toBe(4);
  });
});

describe('MotionCollageLightbox — single-panel zoom (initial focus)', () => {
  it('renders the focused panel as a single contained image when initialPanelIndex is set', () => {
    const html = renderToStaticMarkup(
      <MotionCollageLightbox
        panelUrls={['a.png', 'b.png', 'c.png', 'd.png']}
        grid={{ cols: 2, rows: 2 }}
        shotIndex={0}
        initialPanelIndex={2}
        onClose={() => {}}
      />,
    );
    // Focused panel renders, others don't.
    expect(html).toContain('src="c.png"');
    expect(html).not.toContain('src="a.png"');
    expect(html).not.toContain('src="b.png"');
    expect(html).not.toContain('src="d.png"');
    expect(html).toContain('viewing panel 3');
    // Grid view CSS not present when focused.
    expect(html).not.toMatch(/grid-template-columns:repeat\(2,\s*1fr\)/);
  });
});

describe('MotionCollageLightbox — accessibility', () => {
  it('exposes role=dialog with an aria-label', () => {
    const html = renderToStaticMarkup(
      <MotionCollageLightbox
        panelUrls={['a.png']}
        grid={{ cols: 1, rows: 1 }}
        shotIndex={0}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-label="Motion collage shot 1/);
  });
});

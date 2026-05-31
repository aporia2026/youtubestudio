/**
 * Unit tests for <ThumbnailRenderer> — the Phase B1 SVG renderer that
 * applies r2.8 finishing overlays client-side on top of an AI image.
 *
 * Vitest + React: rendered output is serialised via `renderToStaticMarkup`
 * (cheaper than a full DOM and good enough to assert on the SVG structure).
 * We only check WHICH overlays are rendered + their key attributes, not
 * pixel parity with the server — server vs browser parity is a manual
 * verification, not a unit-test job.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThumbnailRenderer } from '@/components/thumbnails/ThumbnailRenderer';

describe('ThumbnailRenderer — base path', () => {
  it('renders just the base image when no postProcess and no titleBar', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
      />,
    );
    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.com/x.png"');
    // Empty SVG (no overlays).
    expect(html).toMatch(/<svg[^>]*><\/svg>/);
  });

  it('applies CSS filter when postProcess.filter is set', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        postProcess={{ filter: 'grayscale' }}
      />,
    );
    expect(html).toContain('filter:grayscale(1)');
  });

  it('passes children through above the overlays', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
      >
        <svg data-testid="region-overlay" />
      </ThumbnailRenderer>,
    );
    expect(html).toContain('data-testid="region-overlay"');
  });
});

describe('ThumbnailRenderer — finishing overlays', () => {
  it('renders a vignette radialGradient when postProcess.vignette is set', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        postProcess={{
          vignette: { color: '#000000', intensity: 0.4, radius: 0.5 },
        }}
      />,
    );
    expect(html).toContain('<radialGradient');
    expect(html).toContain('stop-color="#000000"');
    expect(html).toContain('stop-opacity="0.4"');
  });

  it('renders a tint flat rect + split-tone layers when configured', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        postProcess={{
          tint: {
            color: '#ffb27a',
            intensity: 0.3,
            blendMode: 'soft-light',
            shadows: '#0a3a5a',
            highlights: '#ffd28a',
            splitToneStrength: 0.5,
          },
        }}
      />,
    );
    // Base wash.
    expect(html).toContain('fill="#ffb27a"');
    // Split-tone shadows (multiply blend).
    expect(html).toContain('fill="#0a3a5a"');
    // Split-tone highlights (screen blend).
    expect(html).toContain('fill="#ffd28a"');
    // mix-blend-mode CSS — at least the soft-light blend from the base.
    expect(html).toContain('mix-blend-mode:soft-light');
  });

  it('renders a light-leak radialGradient anchored at the configured corner', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        postProcess={{
          lightLeak: {
            color: '#ffd28a',
            intensity: 0.4,
            radius: 0.6,
            position: 'top-right',
            blendMode: 'screen',
          },
        }}
      />,
    );
    expect(html).toContain('<radialGradient');
    // top-right anchor: cx = width, cy = 0.
    expect(html).toContain('cx="400"');
    expect(html).toContain('cy="0"');
    expect(html).toContain('mix-blend-mode:screen');
  });

  it('renders a halftone pattern with a circle at the configured spacing', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        postProcess={{
          halftone: {
            color: '#000000',
            opacity: 0.3,
            dotSize: 1.5,
            spacing: 6,
            blendMode: 'multiply',
          },
        }}
      />,
    );
    expect(html).toContain('<pattern');
    expect(html).toContain('<circle');
    expect(html).toContain('r="1.5"');
    expect(html).toContain('mix-blend-mode:multiply');
  });

  it('renders a frame with two strokes when style is "double"', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        postProcess={{
          frame: { color: '#ffffff', thickness: 8, inset: 16, style: 'double' },
        }}
      />,
    );
    // Two <rect> elements with stroke="#ffffff" (one for each ring).
    const matches = html.match(/stroke="#ffffff"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('renders letterbox bars only on the configured sides', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        postProcess={{
          letterbox: { color: '#000000', top: 20, bottom: 20, left: 0, right: 0 },
        }}
      />,
    );
    // Two rects with fill="#000000" — top and bottom bars.
    const matches = html.match(/<rect[^/]*fill="#000000"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('renders dust with feTurbulence + feFlood', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        postProcess={{
          dust: { color: '#ffffff', intensity: 0.4, density: 0.3, seed: 7 },
        }}
      />,
    );
    expect(html).toContain('<feTurbulence');
    expect(html).toContain('<feFlood');
    // Light dust → screen blend.
    expect(html).toContain('mix-blend-mode:screen');
  });

  it('namespaces gradient/pattern IDs so multiple renderers do not collide', () => {
    const html = renderToStaticMarkup(
      <div>
        <ThumbnailRenderer
          baseImageUrl="https://example.com/a.png"
          canvasWidth={400}
          canvasHeight={225}
          postProcess={{ vignette: { color: '#000', intensity: 0.5, radius: 0.5 } }}
        />
        <ThumbnailRenderer
          baseImageUrl="https://example.com/b.png"
          canvasWidth={400}
          canvasHeight={225}
          postProcess={{ vignette: { color: '#000', intensity: 0.5, radius: 0.5 } }}
        />
      </div>,
    );
    // Each renderer's useId() prefix should produce DIFFERENT ids.
    const ids = Array.from(html.matchAll(/<radialGradient id="([^"]+)"/g)).map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('ThumbnailRenderer — free-form cells (Phase B4)', () => {
  it('renders an <svg> base with cell rects when `cells` is provided (no <img>)', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        canvasWidth={400}
        canvasHeight={225}
        cells={[
          { bounds: { x: 10, y: 10, w: 180, h: 200 }, bgColor: '#ff0000', emoji: '🔥', label: 'A' },
          { bounds: { x: 210, y: 10, w: 180, h: 200 }, bgColor: '#00ff00', emoji: '⚡', label: 'B' },
        ]}
      />,
    );
    // No <img> tag in free-form mode.
    expect(html).not.toContain('<img');
    // Both cells' background colours land.
    expect(html).toContain('fill="#ff0000"');
    expect(html).toContain('fill="#00ff00"');
    // Both emojis render as text.
    expect(html).toContain('🔥');
    expect(html).toContain('⚡');
    // Both labels render too.
    expect(html).toContain('>A<');
    expect(html).toContain('>B<');
  });

  it('falls back to white background when bgColor is omitted', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        canvasWidth={200}
        canvasHeight={200}
        cells={[{ bounds: { x: 0, y: 0, w: 200, h: 200 }, label: 'X' }]}
      />,
    );
    expect(html).toContain('fill="#ffffff"');
  });

  it('renders a Lucide icon inline when iconSlug is set (takes precedence over emoji)', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        canvasWidth={200}
        canvasHeight={200}
        cells={[
          {
            bounds: { x: 0, y: 0, w: 200, h: 200 },
            bgColor: '#ffffff',
            emoji: '🎯',
            iconSlug: 'star',
            iconColor: '#ff8800',
            label: 'Star',
          },
        ]}
      />,
    );
    // Lucide star path content includes a polygon — verify it's inlined.
    expect(html).toMatch(/polygon|path/);
    // Icon colour applied to the wrapper `<g>`.
    expect(html).toContain('stroke="#ff8800"');
    // The emoji 🎯 should NOT be rendered (icon wins).
    expect(html).not.toContain('🎯');
  });

  it('falls back to emoji when iconSlug is unknown', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        canvasWidth={200}
        canvasHeight={200}
        cells={[
          {
            bounds: { x: 0, y: 0, w: 200, h: 200 },
            emoji: '🚀',
            iconSlug: 'definitely-not-a-real-icon-slug',
          },
        ]}
      />,
    );
    // Unknown icon → renderer skips the icon branch and emoji shows.
    expect(html).toContain('🚀');
  });

  it('renders a circle cell with a stroked <circle> instead of a rect border', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        canvasWidth={400}
        canvasHeight={400}
        cells={[
          {
            bounds: { x: 0, y: 0, w: 400, h: 400 },
            bgColor: '#ff8800',
            shape: 'circle',
            label: 'X',
          },
        ]}
      />,
    );
    // Circle mode renders a <circle> for the disc + a stroked outer
    // <circle> for the border. Verify both are present.
    const circleCount = (html.match(/<circle/g) ?? []).length;
    expect(circleCount).toBeGreaterThanOrEqual(2);
    // Cell bg colour applied to the disc.
    expect(html).toContain('fill="#ff8800"');
  });

  it('rounded shape adds non-zero rx on the cell background', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        canvasWidth={200}
        canvasHeight={200}
        cells={[
          {
            bounds: { x: 0, y: 0, w: 200, h: 200 },
            shape: 'rounded',
            bgColor: '#ff0000',
          },
        ]}
      />,
    );
    // 8 % of min(w, h) = 16. The cell rect should have rx="16".
    expect(html).toMatch(/rx="16"/);
  });

  it('applies a canvasBackgroundGradient via inline CSS on the cells SVG', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        canvasWidth={200}
        canvasHeight={200}
        cells={[]}
        canvasBackgroundGradient={{ from: '#ff0000', to: '#0000ff', angle: 45 }}
      />,
    );
    // The free-form SVG carries the gradient via inline style. We don't
    // assert on the exact serialisation (React varies between
    // `background:linear-gradient(...)` and `background:linear-gradient(...);` —
    // just verify the gradient identifier + colours are present.
    expect(html).toContain('linear-gradient');
    expect(html).toContain('#ff0000');
    expect(html).toContain('#0000ff');
    expect(html).toContain('45deg');
  });

  it('cells path still applies the post-process overlays on top', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        canvasWidth={200}
        canvasHeight={200}
        cells={[{ bounds: { x: 0, y: 0, w: 200, h: 200 }, bgColor: '#abcdef' }]}
        postProcess={{
          frame: { color: '#ff00ff', thickness: 4, inset: 8, style: 'solid' },
        }}
      />,
    );
    // Cell bg.
    expect(html).toContain('fill="#abcdef"');
    // Frame overlay stroke.
    expect(html).toContain('stroke="#ff00ff"');
  });
});

describe('ThumbnailRenderer — title bar', () => {
  it('renders title text + subtitle when titleBar is provided', () => {
    const html = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        titleBar={{
          text: 'Hello world',
          subtitle: 'A subtitle',
          position: 'bottom',
          heightFraction: 0.2,
          align: 'center',
          backgroundColor: '#000000',
          backgroundOpacity: 1,
          textColor: '#ffffff',
          fontFamily: 'Patrick Hand',
        }}
      />,
    );
    expect(html).toContain('Hello world');
    expect(html).toContain('A subtitle');
    expect(html).toContain('font-family="Patrick Hand"');
    expect(html).toContain('fill="#ffffff"');
  });

  it('positions the title bar at y=0 for "top" and y>0 for "bottom"', () => {
    const top = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        titleBar={{
          text: 'top',
          position: 'top',
          heightFraction: 0.2,
          align: 'center',
          backgroundColor: '#000000',
          backgroundOpacity: 1,
          textColor: '#ffffff',
          fontFamily: 'Patrick Hand',
        }}
      />,
    );
    const bottom = renderToStaticMarkup(
      <ThumbnailRenderer
        baseImageUrl="https://example.com/x.png"
        canvasWidth={400}
        canvasHeight={225}
        titleBar={{
          text: 'bottom',
          position: 'bottom',
          heightFraction: 0.2,
          align: 'center',
          backgroundColor: '#000000',
          backgroundOpacity: 1,
          textColor: '#ffffff',
          fontFamily: 'Patrick Hand',
        }}
      />,
    );
    expect(top).toContain('translate(0, 0)');
    expect(bottom).toContain('translate(0,');
    expect(bottom).not.toContain('translate(0, 0)');
  });
});

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

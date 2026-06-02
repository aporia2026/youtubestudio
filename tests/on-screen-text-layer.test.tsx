/**
 * Unit tests for the renderer-side OnScreenTextLayer routing
 * (legacy vs multi-block path).
 *
 * PR 6 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
 *
 * `OnScreenTextLayer` is the single mount point every scene uses for
 * lower-third text. The routing is:
 *   - shot.onScreenTextBlocks set + non-empty → iterate blocks
 *   - else shot.onScreenText set → legacy single LowerThird
 *   - else null
 * + suppressLowerThird gate that short-circuits everything to null.
 *
 * Since OnScreenTextLayer mounts Remotion components that read hooks,
 * we test the routing decision logic indirectly by rendering inside a
 * minimal Remotion harness. Heavy visual assertions are deferred to
 * manual QA against a real composition.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock Remotion hooks so the components render in SSR. Real renders
// happen during composition mount in the browser/Lambda; the tests
// only need to validate the routing decision (which children mount).
vi.mock('remotion', () => ({
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080 }),
  spring: () => 1,
  interpolate: (_n: number, _from: number[], to: number[]) => to[1] ?? to[0] ?? 0,
  AbsoluteFill: ({ children }: { children?: React.ReactNode }) => <div data-testid="absolute-fill">{children}</div>,
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { OnScreenTextLayer } from '@/remotion/components/OnScreenTextLayer';
import type { VideoShot, BrandKit } from '@/remotion/types';

const minimalBrand: BrandKit = {
  primaryColor: '#FF0000',
  secondaryColor: '#222222',
  backgroundColor: '#FFFFFF',
  textColor: '#111111',
  titleColor: '#000000',
  fontFamily: 'system-ui, sans-serif',
  titleFontFamily: 'system-ui, sans-serif',
};

function shotWith(fields: Partial<VideoShot>): VideoShot {
  return {
    startMs: 0,
    durationMs: 1000,
    sceneType: 'b-roll',
    ...fields,
  };
}

describe('OnScreenTextLayer — routing decision', () => {
  it('returns null when suppressLowerThird is true regardless of data', () => {
    const html = renderToStaticMarkup(
      <OnScreenTextLayer
        shot={shotWith({ onScreenText: 'should not show' })}
        brand={minimalBrand}
        durationInFrames={60}
        suppressLowerThird
      />,
    );
    expect(html).toBe('');
  });

  it('returns null when no text and no blocks', () => {
    const html = renderToStaticMarkup(
      <OnScreenTextLayer
        shot={shotWith({})}
        brand={minimalBrand}
        durationInFrames={60}
      />,
    );
    expect(html).toBe('');
  });

  it('renders the legacy LowerThird when only onScreenText is set', () => {
    const html = renderToStaticMarkup(
      <OnScreenTextLayer
        shot={shotWith({ onScreenText: 'Hello world' })}
        brand={minimalBrand}
        durationInFrames={60}
      />,
    );
    expect(html).toContain('Hello world');
    // Legacy path uses an absolute-positioned wrapper with bottom: offset.
    expect(html).toMatch(/position:absolute/);
  });

  it('renders one PositionedTextBlock per block when onScreenTextBlocks is set', () => {
    const html = renderToStaticMarkup(
      <OnScreenTextLayer
        shot={shotWith({
          onScreenText: 'should be ignored when blocks exist',
          onScreenTextBlocks: [
            { id: 'a', text: 'First', x_pct: 10, y_pct: 20, scale: 1, anchor: 'top-left' },
            { id: 'b', text: 'Second', x_pct: 90, y_pct: 80, scale: 1, anchor: 'bottom-right' },
          ],
        })}
        brand={minimalBrand}
        durationInFrames={60}
      />,
    );
    expect(html).toContain('First');
    expect(html).toContain('Second');
    // Legacy `onScreenText` is shadowed when blocks are present.
    expect(html).not.toContain('should be ignored');
  });

  it('passes the doc variant down as fallback for blocks without their own variant', () => {
    const html = renderToStaticMarkup(
      <OnScreenTextLayer
        shot={shotWith({
          onScreenTextBlocks: [
            { id: 'a', text: 'Inherit yellow', x_pct: 50, y_pct: 50, scale: 1 },
          ],
        })}
        brand={minimalBrand}
        durationInFrames={60}
        variant="doodle-yellow"
      />,
    );
    // Yellow variant uses Lilita font + #FCD34D fill — fingerprint via the color.
    expect(html).toContain('#FCD34D');
  });

  it('per-block variant overrides the doc fallback', () => {
    const html = renderToStaticMarkup(
      <OnScreenTextLayer
        shot={shotWith({
          onScreenTextBlocks: [
            {
              id: 'a',
              text: 'Override default',
              x_pct: 50,
              y_pct: 50,
              scale: 1,
              variant: 'default',
            },
          ],
        })}
        brand={minimalBrand}
        durationInFrames={60}
        variant="doodle-yellow"
      />,
    );
    // Default variant uses red accent (#ef4444 border-left) — fingerprint.
    expect(html).toContain('#ef4444');
    // Yellow variant color must NOT be present.
    expect(html).not.toContain('#FCD34D');
  });

  it('positions each block at its x_pct/y_pct', () => {
    const html = renderToStaticMarkup(
      <OnScreenTextLayer
        shot={shotWith({
          onScreenTextBlocks: [
            { id: 'a', text: 'A', x_pct: 25, y_pct: 75, scale: 1 },
            { id: 'b', text: 'B', x_pct: 80, y_pct: 10, scale: 1 },
          ],
        })}
        brand={minimalBrand}
        durationInFrames={60}
      />,
    );
    expect(html).toContain('left:25%');
    expect(html).toContain('top:75%');
    expect(html).toContain('left:80%');
    expect(html).toContain('top:10%');
  });

  it('applies rotation_deg via CSS transform', () => {
    const html = renderToStaticMarkup(
      <OnScreenTextLayer
        shot={shotWith({
          onScreenTextBlocks: [
            { id: 'a', text: 'Tilted', x_pct: 50, y_pct: 50, scale: 1, rotation_deg: 15 },
          ],
        })}
        brand={minimalBrand}
        durationInFrames={60}
      />,
    );
    expect(html).toMatch(/rotate\(15deg\)/);
  });
});

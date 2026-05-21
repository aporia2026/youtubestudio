import { describe, expect, it } from 'vitest';
import { computeImageCanvas } from '@/lib/render-canvas';

describe('computeImageCanvas', () => {
  it('returns full 1920x1080 when no section title', () => {
    const out = computeImageCanvas();
    expect(out).toEqual({ width: 1920, height: 1080, letterboxed: false, stripeHeightPx: 0 });
  });

  it('returns full frame when section title set but layout is overlay', () => {
    const out = computeImageCanvas({ sectionTitle: 'Intro', sectionTitleLayout: 'overlay' });
    expect(out.width).toBe(1920);
    expect(out.height).toBe(1080);
    expect(out.letterboxed).toBe(false);
    expect(out.stripeHeightPx).toBe(0);
  });

  it('shrinks to 1920x944 for default letterbox (13% stripe, grid 8)', () => {
    const out = computeImageCanvas({ sectionTitle: 'Chapter 1', sectionTitleLayout: 'letterbox' });
    expect(out.width).toBe(1920);
    // 1080 * 0.13 = 140.4 → 140 stripe → 940 available → snap to 944 (nearest mult of 8).
    expect(out.height).toBe(944);
    expect(out.letterboxed).toBe(true);
    expect(out.stripeHeightPx).toBe(140);
  });

  it('defaults to letterbox when section title present and layout undefined', () => {
    const out = computeImageCanvas({ sectionTitle: 'Chapter 1' });
    expect(out.letterboxed).toBe(true);
    expect(out.height).toBe(944);
  });

  it('treats whitespace-only section title as no stripe', () => {
    const out = computeImageCanvas({ sectionTitle: '   ', sectionTitleLayout: 'letterbox' });
    expect(out.letterboxed).toBe(false);
    expect(out.height).toBe(1080);
  });

  it('honours min stripe fraction (6% → 1920x1016)', () => {
    const out = computeImageCanvas({
      sectionTitle: 'X',
      sectionTitleLayout: 'letterbox',
      stripeFraction: 0.06,
    });
    // 1080 * 0.06 = 64.8 → 65 stripe → 1015 → snap to 1016.
    expect(out.height).toBe(1016);
    expect(out.stripeHeightPx).toBe(65);
  });

  it('honours max stripe fraction (22% → 1920x840)', () => {
    const out = computeImageCanvas({
      sectionTitle: 'X',
      sectionTitleLayout: 'letterbox',
      stripeFraction: 0.22,
    });
    // 1080 * 0.22 = 237.6 → 238 stripe → 842 → snap to 840.
    expect(out.height).toBe(840);
    expect(out.stripeHeightPx).toBe(238);
  });

  it('clamps out-of-range stripe fraction to [0.06, 0.22]', () => {
    const tooSmall = computeImageCanvas({
      sectionTitle: 'X',
      sectionTitleLayout: 'letterbox',
      stripeFraction: 0.01,
    });
    expect(tooSmall.height).toBe(1016);
    const tooBig = computeImageCanvas({
      sectionTitle: 'X',
      sectionTitleLayout: 'letterbox',
      stripeFraction: 0.99,
    });
    expect(tooBig.height).toBe(840);
  });

  it('snaps to grid 32 for Wan i2v', () => {
    const out = computeImageCanvas({
      sectionTitle: 'X',
      sectionTitleLayout: 'letterbox',
      grid: 32,
    });
    // 940 → nearest mult of 32 = 928 (940/32=29.375 → round 29 → 928).
    expect(out.height).toBe(928);
    expect(out.width).toBe(1920);
  });

  it('snaps to grid 16 cleanly when canvas already aligned', () => {
    const out = computeImageCanvas({ grid: 16 });
    // 1080 / 16 = 67.5 → snap to 1088 (nearest, 67.5 rounds up via Math.round).
    expect(out.height).toBe(1088);
  });

  it('honours custom frame dimensions (Shorts 1080x1920)', () => {
    const out = computeImageCanvas({ frameWidth: 1080, frameHeight: 1920 });
    expect(out).toEqual({ width: 1080, height: 1920, letterboxed: false, stripeHeightPx: 0 });
  });
});

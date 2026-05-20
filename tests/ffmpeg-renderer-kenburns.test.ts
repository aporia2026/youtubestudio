import { describe, expect, it } from 'vitest';
import {
  buildKenBurnsZoompan,
  recipeForDirection,
} from '@/lib/ffmpeg-renderer/kenburns';
import type { KenBurnsRecipe } from '@/lib/ffmpeg-renderer/types';

const CANVAS_1080P = { canvasWidth: 1920, canvasHeight: 1080 };

describe('buildKenBurnsZoompan — static / no-motion', () => {
  it('returns zoom=1, x=0, y=0 for kind=none', () => {
    const result = buildKenBurnsZoompan({
      recipe: { kind: 'none' },
      totalFrames: 150,
      ...CANVAS_1080P,
    });
    expect(result.z).toBe('1.0');
    expect(result.x).toBe('0');
    expect(result.y).toBe('0');
    expect(result.d).toBe(150);
    expect(result.s).toBe('1920x1080');
  });

  it('clamps a degenerate 1-frame duration to 2 frames (avoids /0 in t expr)', () => {
    const result = buildKenBurnsZoompan({
      recipe: { kind: 'none' },
      totalFrames: 1,
      ...CANVAS_1080P,
    });
    expect(result.d).toBe(2);
  });
});

describe('buildKenBurnsZoompan — pan-zoom motion', () => {
  const baseRecipe: KenBurnsRecipe = {
    kind: 'pan-zoom',
    startZoom: 1.0,
    endZoom: 1.15,
    startCx: 0.5,
    startCy: 0.5,
    endCx: 0.5,
    endCy: 0.5,
  };

  it('builds a t-based interpolation expression for zoom', () => {
    const result = buildKenBurnsZoompan({
      recipe: baseRecipe,
      totalFrames: 100,
      ...CANVAS_1080P,
    });
    // 100 frames → denominator is 99
    expect(result.z).toContain('on/99');
    // 1.0 → 1.15: delta is 0.15
    expect(result.z).toContain('0.15');
    expect(result.z).toContain('1');
  });

  it('emits a constant zoom expression when start === end zoom', () => {
    const result = buildKenBurnsZoompan({
      recipe: {
        ...baseRecipe,
        startZoom: 1.1,
        endZoom: 1.1,
      },
      totalFrames: 90,
      ...CANVAS_1080P,
    });
    // No interpolation needed — just the constant
    expect(result.z).toBe('1.1');
  });

  it('clamps zoom outside [1.0, 2.0]', () => {
    const result = buildKenBurnsZoompan({
      recipe: {
        ...baseRecipe,
        startZoom: 0.5,  // below floor
        endZoom: 3.0,    // above ceiling
      },
      totalFrames: 30,
      ...CANVAS_1080P,
    });
    // 1.0 → 2.0 after clamp: delta is 1.0
    expect(result.z).toContain('1');
    expect(result.z).toContain('on/29');
  });

  it('clamps center coords outside [0, 1]', () => {
    const result = buildKenBurnsZoompan({
      recipe: {
        ...baseRecipe,
        startCx: -0.2,
        endCx: 1.7,
        startCy: 0.5,
        endCy: 0.5,
      },
      totalFrames: 30,
      ...CANVAS_1080P,
    });
    // x and y must reference iw/ih (not break on the corrupt center)
    expect(result.x).toContain('iw*');
    expect(result.y).toContain('ih*');
  });

  it('produces an x expression that depends on zoom (centered framing math)', () => {
    const result = buildKenBurnsZoompan({
      recipe: baseRecipe,
      totalFrames: 30,
      ...CANVAS_1080P,
    });
    // x = iw * (cx - 1/(2*z)) — must reference iw, cx-like expression,
    // and the zoom expression in the denominator
    expect(result.x).toMatch(/iw\*/);
    expect(result.x).toContain('1/(2*');
  });

  it('substitutes NaN-resistant defaults when zoom is NaN', () => {
    const result = buildKenBurnsZoompan({
      recipe: {
        ...baseRecipe,
        startZoom: Number.NaN,
        endZoom: Number.NaN,
      },
      totalFrames: 30,
      ...CANVAS_1080P,
    });
    // Both NaN clamps to ZOOM_BOUNDS.min = 1.0 → constant expression
    expect(result.z).toBe('1');
  });

  it('never emits scientific notation', () => {
    const result = buildKenBurnsZoompan({
      recipe: baseRecipe,
      totalFrames: 100,
      ...CANVAS_1080P,
    });
    // Scientific notation breaks ffmpeg's expression parser.
    expect(result.z).not.toMatch(/e[+-]/);
    expect(result.x).not.toMatch(/e[+-]/);
    expect(result.y).not.toMatch(/e[+-]/);
  });
});

describe('recipeForDirection', () => {
  it('zoom-in: zoom rises, center stays at 0.5', () => {
    const r = recipeForDirection('zoom-in');
    expect(r.kind).toBe('pan-zoom');
    if (r.kind !== 'pan-zoom') throw new Error('expected pan-zoom recipe');
    expect(r.endZoom).toBeGreaterThan(r.startZoom);
    expect(r.startCx).toBe(0.5);
    expect(r.endCx).toBe(0.5);
  });

  it('zoom-out: zoom falls, center stays at 0.5', () => {
    const r = recipeForDirection('zoom-out');
    if (r.kind !== 'pan-zoom') throw new Error('expected pan-zoom recipe');
    expect(r.startZoom).toBeGreaterThan(r.endZoom);
    expect(r.startCx).toBe(0.5);
    expect(r.endCx).toBe(0.5);
  });

  it('pan-left: center moves leftward', () => {
    const r = recipeForDirection('pan-left');
    if (r.kind !== 'pan-zoom') throw new Error('expected pan-zoom recipe');
    expect(r.endCx).toBeLessThan(r.startCx);
    // Vertical center stays put on a horizontal pan
    expect(r.startCy).toBe(r.endCy);
    // Zoom held constant on a pan
    expect(r.startZoom).toBe(r.endZoom);
  });

  it('pan-right: center moves rightward', () => {
    const r = recipeForDirection('pan-right');
    if (r.kind !== 'pan-zoom') throw new Error('expected pan-zoom recipe');
    expect(r.endCx).toBeGreaterThan(r.startCx);
  });

  it('pan-up: center moves upward (smaller cy)', () => {
    const r = recipeForDirection('pan-up');
    if (r.kind !== 'pan-zoom') throw new Error('expected pan-zoom recipe');
    expect(r.endCy).toBeLessThan(r.startCy);
  });

  it('pan-down: center moves downward (larger cy)', () => {
    const r = recipeForDirection('pan-down');
    if (r.kind !== 'pan-zoom') throw new Error('expected pan-zoom recipe');
    expect(r.endCy).toBeGreaterThan(r.startCy);
  });

  it('falls through to zoom-in for unknown / undefined directions', () => {
    const r = recipeForDirection(undefined);
    if (r.kind !== 'pan-zoom') throw new Error('expected pan-zoom recipe');
    expect(r.endZoom).toBeGreaterThan(r.startZoom);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MICRO_WIGGLE_DEFAULTS,
  microWiggleCssTransform,
  microWiggleTransform,
} from '@/remotion/micro-wiggle-math';

// ─── microWiggleTransform ────────────────────────────────────────────
//
// Pure function — frame-determinism is the architectural contract:
// preview and Lambda renders MUST return byte-identical transforms
// for the same (frame, fps, opts), or the character "jumps" between
// the two outputs.

describe('microWiggleTransform — frame-determinism', () => {
  it('returns identical transforms for identical (frame, fps, opts)', () => {
    const a = microWiggleTransform(42, 30);
    const b = microWiggleTransform(42, 30);
    expect(a).toEqual(b);
  });

  it('does not mutate or depend on call order (no hidden state)', () => {
    const a = microWiggleTransform(10, 30);
    microWiggleTransform(99999, 60); // call with very different inputs
    const a2 = microWiggleTransform(10, 30);
    expect(a).toEqual(a2);
  });
});

describe('microWiggleTransform — zero frame', () => {
  it('at frame=0 returns rotation=0 and translateX=0 (sin(0) = 0)', () => {
    const t = microWiggleTransform(0, 30);
    expect(t.rotation).toBe(0);
    expect(t.translateX).toBe(0);
    // translateY uses a 90° phase offset so at t=0 it's at its peak.
    expect(t.translateY).toBeCloseTo(MICRO_WIGGLE_DEFAULTS.translatePx, 5);
  });
});

describe('microWiggleTransform — amplitude bounds', () => {
  it('rotation never exceeds the configured rotationDeg in magnitude', () => {
    // Walk 0 → 600 frames at 30 fps = 0 → 20 s of motion. Every
    // sample must stay inside [-rotationDeg, +rotationDeg].
    for (let f = 0; f <= 600; f += 7) {
      const t = microWiggleTransform(f, 30);
      expect(Math.abs(t.rotation)).toBeLessThanOrEqual(MICRO_WIGGLE_DEFAULTS.rotationDeg + 1e-9);
    }
  });

  it('translateX and translateY never exceed the configured translatePx in magnitude', () => {
    for (let f = 0; f <= 600; f += 7) {
      const t = microWiggleTransform(f, 30);
      expect(Math.abs(t.translateX)).toBeLessThanOrEqual(MICRO_WIGGLE_DEFAULTS.translatePx + 1e-9);
      expect(Math.abs(t.translateY)).toBeLessThanOrEqual(MICRO_WIGGLE_DEFAULTS.translatePx + 1e-9);
    }
  });

  it('respects a custom rotationDeg / translatePx', () => {
    const opts = { rotationDeg: 3, translatePx: 6 };
    for (let f = 0; f <= 300; f += 9) {
      const t = microWiggleTransform(f, 30, opts);
      expect(Math.abs(t.rotation)).toBeLessThanOrEqual(3 + 1e-9);
      expect(Math.abs(t.translateX)).toBeLessThanOrEqual(6 + 1e-9);
      expect(Math.abs(t.translateY)).toBeLessThanOrEqual(6 + 1e-9);
    }
  });
});

describe('microWiggleTransform — frequency', () => {
  it('completes a full rotation cycle in 1/rotationFreqHz seconds', () => {
    // Default rotationFreqHz = 0.6 Hz → period = 1/0.6 s ≈ 1.667 s
    // At 30 fps that's ~50 frames. After one full period the rotation
    // should be back to (very near) 0.
    const periodFrames = Math.round(30 / MICRO_WIGGLE_DEFAULTS.rotationFreqHz);
    const t = microWiggleTransform(periodFrames, 30);
    expect(t.rotation).toBeCloseTo(0, 4);
  });
});

describe('microWiggleTransform — fps fallback', () => {
  it('falls back to 30 fps when given a non-positive fps', () => {
    const tBad = microWiggleTransform(15, 0);
    const tGood = microWiggleTransform(15, 30);
    expect(tBad).toEqual(tGood);
  });

  it('falls back to 30 fps when given NaN', () => {
    const tBad = microWiggleTransform(15, Number.NaN);
    const tGood = microWiggleTransform(15, 30);
    expect(tBad).toEqual(tGood);
  });
});

describe('microWiggleTransform — uncorrelated X / Y', () => {
  it('produces translateY != translateX at most frames (phase offset works)', () => {
    // The two axes use the same frequency but a 90° phase shift on Y
    // so they don't degenerate into a single linear bob. Across a
    // sample of frames, the two should disagree the vast majority of
    // the time.
    let differingFrames = 0;
    const totalFrames = 100;
    for (let f = 1; f <= totalFrames; f++) {
      const t = microWiggleTransform(f, 30);
      if (Math.abs(t.translateX - t.translateY) > 0.01) differingFrames++;
    }
    expect(differingFrames).toBeGreaterThan(80); // most frames have distinct X / Y
  });
});

// ─── microWiggleCssTransform ─────────────────────────────────────────

describe('microWiggleCssTransform', () => {
  it('formats a transform string with rotate + translate', () => {
    const css = microWiggleCssTransform({ rotation: 0.5, translateX: 1.25, translateY: -0.75 });
    expect(css).toMatch(/^rotate\(0\.5000deg\)/);
    expect(css).toMatch(/translate\(1\.2500px, -0\.7500px\)/);
  });

  it('produces a CSS-parseable string for zero values', () => {
    const css = microWiggleCssTransform({ rotation: 0, translateX: 0, translateY: 0 });
    expect(css).toBe('rotate(0.0000deg) translate(0.0000px, 0.0000px)');
  });
});

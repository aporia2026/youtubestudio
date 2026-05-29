import { describe, expect, it } from 'vitest';
import { buildScribbleDrawMask } from '@/remotion/components/ScribbleDraw';

// ─── buildScribbleDrawMask ──────────────────────────────────────────
//
// The CSS gradient driving the reveal. A regression on the stop
// formula shifts every scribble-draw render by a few %, which the
// viewer wouldn't notice but the math IS the visual contract.

describe('buildScribbleDrawMask — direction routing', () => {
  it('uses "to right" for left-to-right (default)', () => {
    expect(buildScribbleDrawMask(0.5, 'left-to-right')).toContain('linear-gradient(to right,');
  });

  it('uses "to bottom" for top-to-bottom', () => {
    expect(buildScribbleDrawMask(0.5, 'top-to-bottom')).toContain('linear-gradient(to bottom,');
  });

  it('uses radial-gradient for radial-out', () => {
    expect(buildScribbleDrawMask(0.5, 'radial-out')).toContain('radial-gradient(circle at center,');
  });
});

describe('buildScribbleDrawMask — progress checkpoints', () => {
  it('at progress=0, the leading edge is at the start (cover fully opaque)', () => {
    const mask = buildScribbleDrawMask(0, 'left-to-right');
    // leading = 0 * 105 = 0; trailing = -5. CSS clamps the negative,
    // and the black stop at 0 effectively keeps the cover opaque
    // everywhere.
    expect(mask).toContain('transparent 0%');
    expect(mask).toContain('transparent -5%');
    expect(mask).toContain('black 0%');
    expect(mask).toContain('black 100%');
  });

  it('at progress=0.5, the leading edge is at ~52.5% (soft window crossing center)', () => {
    const mask = buildScribbleDrawMask(0.5, 'left-to-right');
    // leading = 52.5, trailing = 47.5 with default 5% feather.
    expect(mask).toContain('transparent 47.5%');
    expect(mask).toContain('black 52.5%');
  });

  it('at progress=1, the leading edge is past 100 (cover fully transparent)', () => {
    const mask = buildScribbleDrawMask(1, 'left-to-right');
    // leading = 105, trailing = 100. The trailing-edge transparent
    // stop now covers the whole 0..100 range, leaving the cover
    // fully transparent.
    expect(mask).toContain('transparent 100%');
    expect(mask).toContain('black 105%');
  });
});

describe('buildScribbleDrawMask — clamping', () => {
  it('clamps progress < 0 to 0', () => {
    expect(buildScribbleDrawMask(-0.5, 'left-to-right')).toBe(
      buildScribbleDrawMask(0, 'left-to-right'),
    );
  });

  it('clamps progress > 1 to 1', () => {
    expect(buildScribbleDrawMask(1.5, 'left-to-right')).toBe(
      buildScribbleDrawMask(1, 'left-to-right'),
    );
  });

  it('handles non-finite progress gracefully (Number.NaN)', () => {
    // Math.min/max with NaN returns NaN — but the function should
    // still produce a string the browser tolerates.
    const mask = buildScribbleDrawMask(Number.NaN, 'left-to-right');
    expect(typeof mask).toBe('string');
    expect(mask).toContain('linear-gradient(');
  });
});

describe('buildScribbleDrawMask — feather override', () => {
  it('honours a custom featherPct', () => {
    const mask = buildScribbleDrawMask(0.5, 'left-to-right', 10);
    // leading = 0.5 * 110 = 55; trailing = 45.
    expect(mask).toContain('transparent 45%');
    expect(mask).toContain('black 55%');
  });

  it('a 0-feather still produces a valid gradient (hard wipe edge)', () => {
    const mask = buildScribbleDrawMask(0.5, 'left-to-right', 0);
    // leading = 50, trailing = 50. Both stops at the same %.
    expect(mask).toContain('transparent 50%');
    expect(mask).toContain('black 50%');
  });
});

describe('buildScribbleDrawMask — output is a valid CSS gradient', () => {
  it('always returns a string containing all four gradient stops', () => {
    const directions: Array<Parameters<typeof buildScribbleDrawMask>[1]> = [
      'left-to-right',
      'top-to-bottom',
      'radial-out',
    ];
    for (const direction of directions) {
      for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        const mask = buildScribbleDrawMask(progress, direction);
        expect(mask, `progress=${progress} direction=${direction}`).toMatch(/transparent .+%/);
        expect(mask, `progress=${progress} direction=${direction}`).toMatch(/black .+%/);
      }
    }
  });
});

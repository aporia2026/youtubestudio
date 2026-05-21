import { describe, expect, it } from 'vitest';
import { resolveOstRendering } from '@/remotion/utils';

describe('resolveOstRendering', () => {
  // Truth table: every combination of row mode × doc default × text presence.
  // 'bake' and 'none' suppress LowerThird; only 'overlay' surfaces the text.

  it('row=overlay, text present → overlayText set, LowerThird shows', () => {
    const out = resolveOstRendering('overlay', undefined, 'BREAKING NEWS');
    expect(out).toEqual({ mode: 'overlay', overlayText: 'BREAKING NEWS', suppressLowerThird: false });
  });

  it('row=overlay, text empty → no overlayText, LowerThird stays off (nothing to render)', () => {
    const out = resolveOstRendering('overlay', undefined, '');
    expect(out).toEqual({ mode: 'overlay', overlayText: undefined, suppressLowerThird: false });
  });

  it('row=bake → suppress LowerThird so the baked text in the image is not duplicated', () => {
    const out = resolveOstRendering('bake', undefined, 'SALE');
    expect(out).toEqual({ mode: 'bake', overlayText: undefined, suppressLowerThird: true });
  });

  it('row=none → suppress LowerThird, no text anywhere', () => {
    const out = resolveOstRendering('none', undefined, 'still has text in field');
    expect(out).toEqual({ mode: 'none', overlayText: undefined, suppressLowerThird: true });
  });

  it('row undefined, doc default=overlay → inherits overlay', () => {
    const out = resolveOstRendering(undefined, 'overlay', 'Hi');
    expect(out.mode).toBe('overlay');
    expect(out.overlayText).toBe('Hi');
    expect(out.suppressLowerThird).toBe(false);
  });

  it('row undefined, doc default=bake → inherits bake', () => {
    const out = resolveOstRendering(undefined, 'bake', 'Hi');
    expect(out.mode).toBe('bake');
    expect(out.overlayText).toBeUndefined();
    expect(out.suppressLowerThird).toBe(true);
  });

  it('both undefined → bake (pre-Phase-5 back-compat)', () => {
    const out = resolveOstRendering(undefined, undefined, 'Hi');
    expect(out.mode).toBe('bake');
    expect(out.suppressLowerThird).toBe(true);
  });

  it('row override beats doc default', () => {
    const out = resolveOstRendering('bake', 'overlay', 'Hi');
    expect(out.mode).toBe('bake');
    expect(out.overlayText).toBeUndefined();
  });

  it('whitespace-only text is treated as empty for overlay rendering', () => {
    const out = resolveOstRendering('overlay', undefined, '   \t  ');
    expect(out.overlayText).toBeUndefined();
    expect(out.suppressLowerThird).toBe(false);
  });

  it('overlayText is trimmed', () => {
    const out = resolveOstRendering('overlay', undefined, '   BREAKING NEWS   ');
    expect(out.overlayText).toBe('BREAKING NEWS');
  });
});

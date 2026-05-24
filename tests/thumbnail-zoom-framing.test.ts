import { describe, expect, it } from 'vitest';
import {
  containFraming,
  planRegionFraming,
  projectBoxOnCanvas,
  regionFraming,
} from '@/remotion/scenes/ThumbnailZoomScene';
import type { ThumbnailRegion } from '@/remotion/types';

/**
 * Tests for the thumbnail-zoom camera-framing math.
 *
 * The renderer is hard to unit-test (Remotion + DOM), but the framing
 * functions are pure. The interesting invariants live there:
 *
 *  1) **No brand-background leak in the visible area.** In camera
 *     mode the visible area is the whole canvas, so the image must
 *     cover it. In clip mode the visible area is the clip rect (=
 *     the region's projected bbox), so the region's projected bbox
 *     must lie inside the image's projected bbox.
 *  2) **Mode detection is exact.** `clipMode` should be true exactly
 *     when the region's CONTAIN scale doesn't exceed the whole-image
 *     CONTAIN scale — i.e. when the camera can't physically zoom
 *     further than contain.
 *  3) **Camera-mode behaviour is unchanged** from before the
 *     2026-05-25 spotlight-clip change (Morris-Worm regression case
 *     from commit 5a332f7).
 */

const CANVAS_16_9 = { cW: 1920, cH: 1080 };

function region(
  partial: Partial<ThumbnailRegion> & Pick<ThumbnailRegion, 'x' | 'y' | 'w' | 'h'>,
): ThumbnailRegion {
  return { id: 'r1', label: '', ...partial };
}

/** True iff the scaled+translated image fully covers the canvas. */
function imageFillsCanvas(
  scale: number, focusX: number, focusY: number,
  imgW: number, imgH: number, cW: number, cH: number,
): boolean {
  const tx = cW / 2 - focusX * scale;
  const ty = cH / 2 - focusY * scale;
  const left = tx;
  const top = ty;
  const right = tx + imgW * scale;
  const bottom = ty + imgH * scale;
  const EPS = 1e-6;
  return left <= EPS && top <= EPS && right >= cW - EPS && bottom >= cH - EPS;
}

/** True iff the projected box lies inside the canvas-projected image. */
function projectedBoxInsideImage(
  scale: number, focusX: number, focusY: number,
  imgW: number, imgH: number,
  boxLeft: number, boxTop: number, boxRight: number, boxBottom: number,
  cW: number, cH: number,
): boolean {
  const tx = cW / 2 - focusX * scale;
  const ty = cH / 2 - focusY * scale;
  const imgL = tx, imgT = ty;
  const imgR = tx + imgW * scale;
  const imgB = ty + imgH * scale;
  const pL = boxLeft * scale + tx;
  const pT = boxTop * scale + ty;
  const pR = boxRight * scale + tx;
  const pB = boxBottom * scale + ty;
  const EPS = 1e-6;
  return pL >= imgL - EPS && pT >= imgT - EPS && pR <= imgR + EPS && pB <= imgB + EPS;
}

describe('planRegionFraming — clip-mode detection', () => {
  it('flags full-height grid regions as clip mode (the n-level bug)', () => {
    // 7-level countdown thumbnail, 1280×720, each region 183×720
    // (full image height). Canvas 16:9. With default padding 15.
    // Region's CONTAIN scale equals the whole-image CONTAIN scale, so
    // a real zoom is physically impossible — clip-mode spotlight is
    // the only way to make the animation feel like a zoom.
    const imgW = 1280, imgH = 720;
    const r = region({ x: 549, y: 0, w: 183, h: imgH });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 15);
    expect(plan.clipMode).toBe(true);
  });

  it('flags full-width banner regions as clip mode', () => {
    const imgW = 1280, imgH = 720;
    const r = region({ x: 0, y: 0, w: imgW, h: 120 });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 0);
    expect(plan.clipMode).toBe(true);
  });

  it('flags interior regions as camera mode (Morris-Worm regression case)', () => {
    // Region (0,0,279,346) on 1536×1024 — interior region whose
    // CONTAIN scale (3.12) exceeds the whole-image CONTAIN scale
    // (1.05). The camera CAN zoom, so we use the existing clamped
    // framing with neighbours visible.
    const imgW = 1536, imgH = 1024;
    const r = region({ x: 0, y: 0, w: 279, h: 346 });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 0);
    expect(plan.clipMode).toBe(false);
  });

  it('flags small centred interior regions as camera mode', () => {
    const imgW = 1536, imgH = 1024;
    const r = region({ x: 600, y: 400, w: 200, h: 200 });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 25);
    expect(plan.clipMode).toBe(false);
  });
});

describe('planRegionFraming — no-letterbox-in-visible-area invariant', () => {
  it('camera mode (interior region): image fills the canvas', () => {
    const imgW = 1536, imgH = 1024;
    const r = region({ x: 600, y: 400, w: 200, h: 200 });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 25);

    expect(plan.clipMode).toBe(false);
    const { scale, focusX, focusY } = plan.framing;
    expect(imageFillsCanvas(scale, focusX, focusY, imgW, imgH, CANVAS_16_9.cW, CANVAS_16_9.cH)).toBe(true);
  });

  it('clip mode (full-height region): region projected bbox is inside the image bbox', () => {
    const imgW = 1280, imgH = 720;
    const r = region({ x: 549, y: 0, w: 183, h: imgH });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 15);

    expect(plan.clipMode).toBe(true);
    const { scale, focusX, focusY } = plan.framing;
    expect(projectedBoxInsideImage(
      scale, focusX, focusY, imgW, imgH,
      plan.paddedBox.left, plan.paddedBox.top, plan.paddedBox.right, plan.paddedBox.bottom,
      CANVAS_16_9.cW, CANVAS_16_9.cH,
    )).toBe(true);
  });

  it('every region in a 7-column grid produces a visible-area filled with image pixels', () => {
    // Sweep grid × padding range. In each case either the image
    // covers the canvas (camera mode) or the region's projected
    // bbox is inside the image's projected bbox (clip mode). No
    // background letterbox ever appears in the visible area.
    const imgW = 1280, imgH = 720;
    const colW = imgW / 7;

    for (let col = 0; col < 7; col++) {
      for (const padding of [0, 5, 15, 25, 50]) {
        const r = region({ x: col * colW, y: 0, w: colW, h: imgH });
        const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, padding);
        const { scale, focusX, focusY } = plan.framing;

        const ok = plan.clipMode
          ? projectedBoxInsideImage(
              scale, focusX, focusY, imgW, imgH,
              plan.paddedBox.left, plan.paddedBox.top, plan.paddedBox.right, plan.paddedBox.bottom,
              CANVAS_16_9.cW, CANVAS_16_9.cH,
            )
          : imageFillsCanvas(scale, focusX, focusY, imgW, imgH, CANVAS_16_9.cW, CANVAS_16_9.cH);

        expect(ok, `col ${col}, padding ${padding}, clipMode ${plan.clipMode}`).toBe(true);
      }
    }
  });

  it('image intrinsically smaller than the canvas still fills the canvas (camera mode)', () => {
    // Tiny 640×360 thumbnail upscaled into a 1920×1080 canvas. The
    // small interior region picks camera mode and the image must
    // upscale to fill the canvas.
    const imgW = 640, imgH = 360;
    const r = region({ x: 100, y: 50, w: 80, h: 60 });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 30);

    expect(plan.clipMode).toBe(false);
    const { scale, focusX, focusY } = plan.framing;
    expect(imageFillsCanvas(scale, focusX, focusY, imgW, imgH, CANVAS_16_9.cW, CANVAS_16_9.cH)).toBe(true);
  });
});

describe('planRegionFraming — clip-mode spotlight centring', () => {
  it('centres a full-height region at the canvas centre via unclamped focus', () => {
    // The whole point of clip mode: shift the image so the region's
    // centre lands at canvas centre. With clip = projected bbox, the
    // viewer sees only that region, perfectly centred.
    const imgW = 1280, imgH = 720;
    const r = region({ x: 549, y: 0, w: 183, h: imgH });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 0);
    const clip = projectBoxOnCanvas(plan.paddedBox, plan.framing, CANVAS_16_9.cW, CANVAS_16_9.cH);

    const clipCenterX = (clip.left + clip.right) / 2;
    const clipCenterY = (clip.top + clip.bottom) / 2;
    expect(clipCenterX).toBeCloseTo(CANVAS_16_9.cW / 2, 6);
    expect(clipCenterY).toBeCloseTo(CANVAS_16_9.cH / 2, 6);
  });

  it('centres the leftmost grid region at the canvas centre (no clamp to image edge)', () => {
    // Pre-fix the leftmost column's focus would have been clamped
    // to halfW = imageCenter, leaving the region on the far left
    // of the canvas. Clip mode lifts the clamp so the region
    // spotlight is properly centred.
    const imgW = 1280, imgH = 720;
    const colW = imgW / 7;
    const r = region({ x: 0, y: 0, w: colW, h: imgH });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 0);
    const clip = projectBoxOnCanvas(plan.paddedBox, plan.framing, CANVAS_16_9.cW, CANVAS_16_9.cH);

    const clipCenterX = (clip.left + clip.right) / 2;
    expect(clipCenterX).toBeCloseTo(CANVAS_16_9.cW / 2, 6);
  });
});

describe('regionFraming (camera-mode legacy export)', () => {
  it('Morris-Worm tile case from commit 5a332f7 still produces the expected CONTAIN framing', () => {
    // Regression for the prior switch from COVER to CONTAIN. Region
    // (0,0,279,346) on a 1536×1024 thumbnail in a 1920×1080 canvas
    // with zero padding. The contain scale is height-bound: 1080/346.
    // The corner region's centre gets clamped up to the half-canvas
    // inset so the image keeps filling the canvas (camera mode).
    const imgW = 1536, imgH = 1024;
    const r = region({ x: 0, y: 0, w: 279, h: 346 });
    const expectedScale = CANVAS_16_9.cH / 346;
    const expectedHalfW = CANVAS_16_9.cW / (2 * expectedScale);
    const expectedHalfH = CANVAS_16_9.cH / (2 * expectedScale);
    const f = regionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 0);

    expect(f.scale).toBeCloseTo(expectedScale, 6);
    expect(f.focusX).toBeCloseTo(expectedHalfW, 6);
    expect(f.focusY).toBeCloseTo(expectedHalfH, 6);
    expect(imageFillsCanvas(f.scale, f.focusX, f.focusY, imgW, imgH,
      CANVAS_16_9.cW, CANVAS_16_9.cH)).toBe(true);
  });

  it('zero-padding result on an interior region is unchanged by the padding clamp', () => {
    const imgW = 1536, imgH = 1024;
    const r = region({ x: 400, y: 300, w: 200, h: 200 });
    const f = regionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 0);

    expect(f.scale).toBeCloseTo(Math.min(CANVAS_16_9.cW / 200, CANVAS_16_9.cH / 200), 6);
    expect(f.focusX).toBeCloseTo(500, 6);
    expect(f.focusY).toBeCloseTo(400, 6);
  });

  it('padding on an interior region pulls the camera back symmetrically', () => {
    const imgW = 1536, imgH = 1024;
    const r = region({ x: 668, y: 412, w: 200, h: 200 });
    const fZero = regionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 0);
    const fPadded = regionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 25);

    expect(fPadded.scale).toBeLessThan(fZero.scale);
    expect(fPadded.focusX).toBeCloseTo(fZero.focusX, 1);
    expect(fPadded.focusY).toBeCloseTo(fZero.focusY, 1);
  });
});

describe('containFraming', () => {
  it('returns a scale that exactly fits the image inside the canvas', () => {
    const f = containFraming(1280, 720, CANVAS_16_9.cW, CANVAS_16_9.cH);
    expect(f.scale).toBeCloseTo(1.5, 6);
    expect(f.focusX).toBe(640);
    expect(f.focusY).toBe(360);
  });

  it('handles a non-matching aspect (taller-than-canvas thumbnail)', () => {
    const f = containFraming(800, 1200, CANVAS_16_9.cW, CANVAS_16_9.cH);
    expect(f.scale).toBeCloseTo(0.9, 6);
    expect(f.focusX).toBe(400);
    expect(f.focusY).toBe(600);
  });

  it('guards against zero/negative input dimensions', () => {
    expect(() => containFraming(0, 0, CANVAS_16_9.cW, CANVAS_16_9.cH)).not.toThrow();
    const f = containFraming(0, 0, CANVAS_16_9.cW, CANVAS_16_9.cH);
    expect(Number.isFinite(f.scale)).toBe(true);
    expect(f.scale).toBeGreaterThan(0);
  });
});

describe('projectBoxOnCanvas', () => {
  it('projects the region centre onto the canvas centre under clip-mode framing', () => {
    const imgW = 1280, imgH = 720;
    const r = region({ x: 549, y: 0, w: 183, h: imgH });
    const plan = planRegionFraming(r, CANVAS_16_9.cW, CANVAS_16_9.cH, imgW, imgH, 0);
    const clip = projectBoxOnCanvas(plan.paddedBox, plan.framing, CANVAS_16_9.cW, CANVAS_16_9.cH);

    expect((clip.left + clip.right) / 2).toBeCloseTo(CANVAS_16_9.cW / 2, 6);
    expect((clip.top + clip.bottom) / 2).toBeCloseTo(CANVAS_16_9.cH / 2, 6);
  });
});

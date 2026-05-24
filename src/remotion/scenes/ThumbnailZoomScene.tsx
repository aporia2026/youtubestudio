import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  SPRING_GENTLE,
  SPRING_SMOOTH,
  SPRING_SNAPPY,
} from '../animations/spring-presets';
import { msToFrame } from '../utils';
import type {
  BrandKit,
  ThumbnailRegion,
  ThumbnailTransitionConfig,
  VideoThumbnail,
} from '../types';

/**
 * Section-divider zoom scene.
 *
 * Renders the doc's composite thumbnail and animates the camera onto
 * the row's chosen region. Two transition kinds, chosen via
 * `shot.thumbnailTransition.kind` (with the doc-level default as
 * fallback):
 *
 *  - "hard-cut" (default): open on the full thumbnail, dwell briefly,
 *    zoom into the region, hold for the remainder. Each thumbnail-zoom
 *    shot is independent — there's a cut between sections.
 *
 *  - "smooth": when the previous shot was also a thumbnail-zoom, the
 *    camera starts on THAT shot's region and animates back to the full
 *    thumbnail, then forward to this shot's region. Creates a "tour"
 *    feel across consecutive sections. When the previous shot was
 *    something else (or this is the first thumbnail-zoom shot), the
 *    smooth path degrades to the hard-cut behavior (no jarring jump
 *    from a non-thumbnail scene).
 *
 * Math: rectangles live in INTRINSIC thumbnail-pixel coords. For any
 * "framing" (focus point + scale) we set `transform-origin: 0 0` on the
 * image and translate so the focus point lands at canvas center. Two
 * framing constants drive everything:
 *
 *   contain    — full thumbnail fits inside the canvas (letterboxed)
 *   region(r)  — the region exactly fills the canvas on at least one axis
 *
 * Progress curves come from Remotion's `spring()`, with the preset
 * picked from `transition.easing` so the user's choice in the dialog
 * actually changes feel.
 */
interface ThumbnailZoomSceneProps {
  durationInFrames: number;
  brand: BrandKit;
  thumbnail: VideoThumbnail;
  region: ThumbnailRegion;
  /** When set + kind === 'smooth', the camera starts here and tours via full. */
  previousRegion: ThumbnailRegion | null;
  /** Resolved transition config: row override → doc default → built-in default. */
  transition: ThumbnailTransitionConfig;
  /** When false, suppress the opening 4-frame fade-in. Mirrors the
   *  scene-fade toggle other scenes respect. Defaults `true`. */
  fadeEnabled?: boolean;
  /** Camera padding around the region for the target framing, as a
   *  percent of the region's longest edge added on each side. Higher
   *  pulls the camera back further. Range `[0, 50]`. Resolved upstream
   *  in `productionDocToVideoConfig`; the renderer treats undefined as
   *  0 for backwards compatibility with pre-padding configs. */
  paddingPct?: number;
}

interface Framing {
  scale: number;
  focusX: number;   // image-pixel x
  focusY: number;   // image-pixel y
}

interface PixelTransform {
  scale: number;
  tx: number;       // canvas-pixel x translation
  ty: number;       // canvas-pixel y translation
}

/** Region box after padding, clamped to image bounds (image-pixel coords). */
interface PaddedBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Axis-aligned rectangle in canvas-pixel coords. */
export interface CanvasRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Bundle of everything the scene needs to render a region — the
 * framing the camera will use, the padded image-coord box that
 * framing was derived from, and a `clipMode` flag that tells the
 * renderer whether to spotlight-clip the canvas to the region's
 * projected bounds. Returned by `planRegionFraming`.
 */
export interface RegionPlan {
  framing: Framing;
  paddedBox: PaddedBox;
  /** True when the camera can't physically zoom further than the
   *  whole-image CONTAIN framing (e.g. a full-height column in a
   *  same-aspect canvas). In that case the scene clips the canvas
   *  to the region's projected bounds — brand backgroundColor shows
   *  as letterbox on the sides — so the region still appears visually
   *  zoomed even though the camera scale didn't change. */
  clipMode: boolean;
}

const DEFAULTS = {
  holdAtFullMs: 500,
  zoomDurationMs: 1000,
  holdAtTargetMs: 600,
  easing: 'spring-smooth' as const,
};

// Defend against zero / NaN dimensions. Division-by-zero would produce
// Infinity scale and break the render; clamp to a sane minimum.
const MIN_DIM = 1; // pixels

export function containFraming(tW: number, tH: number, cW: number, cH: number): Framing {
  const w = Math.max(tW, MIN_DIM);
  const h = Math.max(tH, MIN_DIM);
  return {
    scale: Math.min(cW / w, cH / h),
    focusX: w / 2,
    focusY: h / 2,
  };
}

/**
 * Compute the framing that shows the whole marked region with optional
 * breathing-room padding.
 *
 * Switched from COVER to CONTAIN scaling earlier (no more "middle-band
 * crop" on tall+narrow regions inside wide canvases). The 2026-05-20
 * iteration adds `paddingPct` — a creator-controllable amount of
 * breathing room around the region. The 2026-05-25 hardening then
 * fixes a class of bugs that surface on n-level grid thumbnails (e.g.
 * a 7-column countdown where each region is the full image height):
 *
 *  1) Pre-fix, padding inflated the region rectangle naïvely. A full-
 *     height region inflated vertically beyond `imgH`, which dropped
 *     the contain scale BELOW the whole-image contain scale. The
 *     rendered image then became smaller than the canvas and the
 *     brand `backgroundColor` leaked through as letterbox — visible
 *     to the creator as "the zoom shrank my thumbnail and made white
 *     space around it". Fix: inflate the box, then CLAMP it to image
 *     bounds before computing scale, so padding never asks the camera
 *     to frame pixels that don't exist.
 *
 *  2) Belt-and-suspenders: even with the clamp, float rounding and
 *     thumbnails whose intrinsic dimensions are smaller than the
 *     canvas could still produce a scale below the whole-image contain
 *     scale. Cap explicitly at `containScaleWholeImage` so the
 *     rendered image is GUARANTEED to fill the canvas, no matter what
 *     region or padding the creator supplies.
 *
 *  3) Focus follows the padded box centre (not the raw region centre).
 *     Padding pulls the camera back AROUND what the creator marked —
 *     the camera target moves outward symmetrically, balancing the
 *     extra breathing room. Still clamped to image bounds so the
 *     canvas keeps filling with image pixels.
 *
 *   paddingPct = 0  ⇒  byte-identical to the pre-padding contain math.
 *   paddingPct = 50 ⇒  region inflated by 50% of its longest edge on
 *                      each side, then clamped to image bounds —
 *                      camera pulls back as far as the image allows.
 */
function paddedRegionBoxInImage(
  r: ThumbnailRegion, imgW: number, imgH: number, paddingPct: number,
): PaddedBox {
  const safeImgW = Math.max(imgW, MIN_DIM);
  const safeImgH = Math.max(imgH, MIN_DIM);
  const rw = Math.max(r.w, MIN_DIM);
  const rh = Math.max(r.h, MIN_DIM);
  const padPx = Math.max(0, paddingPct) * Math.max(rw, rh) / 100;
  const left = Math.max(0, r.x - padPx);
  const top = Math.max(0, r.y - padPx);
  const right = Math.min(safeImgW, r.x + rw + padPx);
  const bottom = Math.min(safeImgH, r.y + rh + padPx);
  return {
    left, top, right, bottom,
    width: Math.max(MIN_DIM, right - left),
    height: Math.max(MIN_DIM, bottom - top),
  };
}

export function regionFraming(
  r: ThumbnailRegion,
  cW: number,
  cH: number,
  imgW: number,
  imgH: number,
  paddingPct: number,
): Framing {
  return planRegionFraming(r, cW, cH, imgW, imgH, paddingPct).framing;
}

/**
 * Compute the region's CONTAIN framing AND decide whether the scene
 * should spotlight-clip the canvas to that region's bounds.
 *
 * Two modes:
 *
 *  - **Camera mode** (`clipMode === false`): the region's CONTAIN scale
 *    exceeds the whole-image CONTAIN scale, so the camera can
 *    physically zoom into the region. Focus is clamped to image bounds
 *    so the canvas keeps filling with image pixels — neighbouring
 *    content shows in the wide-axis slack (the explicit design
 *    decision from commit 5a332f7).
 *
 *  - **Clip mode** (`clipMode === true`): the region's CONTAIN scale
 *    equals (or is less than) the whole-image CONTAIN scale, so any
 *    camera "zoom" would be a no-op. This happens for full-height or
 *    full-width regions whose aspect matches the image (e.g. one
 *    column of an n-level countdown thumbnail in a 16:9 canvas).
 *    Focus runs UNCLAMPED so the image shifts and the region's
 *    centre lands at canvas centre; the image may extend off-canvas
 *    on the side and the renderer clips the canvas to the region's
 *    projected bounds. Brand `backgroundColor` becomes letterbox.
 *
 * Returns the framing + the padded box (so the scene can project it
 * back onto the canvas to compute the clip rect) + the mode flag.
 */
export function planRegionFraming(
  r: ThumbnailRegion,
  cW: number,
  cH: number,
  imgW: number,
  imgH: number,
  paddingPct: number,
): RegionPlan {
  const box = paddedRegionBoxInImage(r, imgW, imgH, paddingPct);
  const safeImgW = Math.max(imgW, MIN_DIM);
  const safeImgH = Math.max(imgH, MIN_DIM);

  const containScaleWholeImage = Math.min(cW / safeImgW, cH / safeImgH);
  const regionScale = Math.min(cW / box.width, cH / box.height);

  // Strict `>` so float ties (e.g. region exactly matching the image's
  // aspect ratio) take the clip path — that's where the visual zoom
  // would otherwise be invisible.
  const clipMode = !(regionScale > containScaleWholeImage);

  // Belt-and-suspenders min scale even on the camera-mode branch,
  // so a tiny rounding wobble never produces background letterbox
  // outside of clip mode.
  const scale = Math.max(containScaleWholeImage, regionScale);

  const wantFocusX = (box.left + box.right) / 2;
  const wantFocusY = (box.top + box.bottom) / 2;

  let focusX: number;
  let focusY: number;
  if (clipMode) {
    focusX = wantFocusX;
    focusY = wantFocusY;
  } else {
    const halfW = cW / (2 * scale);
    const halfH = cH / (2 * scale);
    const minFocusX = halfW;
    const maxFocusX = Math.max(minFocusX, safeImgW - halfW);
    const minFocusY = halfH;
    const maxFocusY = Math.max(minFocusY, safeImgH - halfH);
    focusX = Math.max(minFocusX, Math.min(maxFocusX, wantFocusX));
    focusY = Math.max(minFocusY, Math.min(maxFocusY, wantFocusY));
  }

  return {
    framing: { scale, focusX, focusY },
    paddedBox: box,
    clipMode,
  };
}

/**
 * Project a padded image-coord box into canvas-coord pixels under a
 * given framing. Used to compute the spotlight clip rect from the
 * region's bounds at the current frame's framing.
 */
export function projectBoxOnCanvas(
  box: PaddedBox, framing: Framing, cW: number, cH: number,
): CanvasRect {
  const xform = framingToPixelTransform(framing, cW, cH);
  return {
    left: box.left * xform.scale + xform.tx,
    top: box.top * xform.scale + xform.ty,
    right: box.right * xform.scale + xform.tx,
    bottom: box.bottom * xform.scale + xform.ty,
  };
}

function fullCanvasRect(cW: number, cH: number): CanvasRect {
  return { left: 0, top: 0, right: cW, bottom: cH };
}

function lerpCanvasRect(a: CanvasRect, b: CanvasRect, p: number): CanvasRect {
  return {
    left: a.left + (b.left - a.left) * p,
    top: a.top + (b.top - a.top) * p,
    right: a.right + (b.right - a.right) * p,
    bottom: a.bottom + (b.bottom - a.bottom) * p,
  };
}

function canvasRectToInset(c: CanvasRect, cW: number, cH: number): string {
  return `inset(${c.top}px ${cW - c.right}px ${cH - c.bottom}px ${c.left}px)`;
}

function lerpFraming(a: Framing, b: Framing, p: number): Framing {
  return {
    scale: a.scale + (b.scale - a.scale) * p,
    focusX: a.focusX + (b.focusX - a.focusX) * p,
    focusY: a.focusY + (b.focusY - a.focusY) * p,
  };
}

function framingToPixelTransform(f: Framing, cW: number, cH: number): PixelTransform {
  const scale = Number.isFinite(f.scale) && f.scale > 0 ? f.scale : 1;
  const fx = Number.isFinite(f.focusX) ? f.focusX : cW / 2;
  const fy = Number.isFinite(f.focusY) ? f.focusY : cH / 2;
  return {
    scale,
    tx: cW / 2 - fx * scale,
    ty: cH / 2 - fy * scale,
  };
}

function easingToSpringConfig(easing: ThumbnailTransitionConfig['easing']) {
  switch (easing) {
    case 'spring-snappy': return SPRING_SNAPPY;
    case 'spring-gentle': return SPRING_GENTLE;
    case 'spring-smooth':
    default:              return SPRING_SMOOTH;
  }
}

export const ThumbnailZoomScene: React.FC<ThumbnailZoomSceneProps> = ({
  durationInFrames, brand, thumbnail, region, previousRegion, transition, fadeEnabled = true,
  paddingPct = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps, width: cW, height: cH } = useVideoConfig();

  const holdAtFullMs = transition.holdAtFullMs ?? DEFAULTS.holdAtFullMs;
  const zoomDurationMs = transition.zoomDurationMs ?? DEFAULTS.zoomDurationMs;
  const easing = transition.easing ?? DEFAULTS.easing;
  const springConfig = easingToSpringConfig(easing);

  const holdFrames = Math.max(0, msToFrame(holdAtFullMs, fps));
  const zoomFrames = Math.max(1, msToFrame(zoomDurationMs, fps));

  // Clamp paddingPct defensively at the renderer too — even though
  // upstream resolution already clamps, a hand-edited config or a
  // legacy row could carry an out-of-bounds value. Caps at 50.
  const clampedPadding = Math.max(0, Math.min(50, paddingPct));

  const contain = containFraming(thumbnail.width, thumbnail.height, cW, cH);
  const targetPlan = planRegionFraming(
    region, cW, cH, thumbnail.width, thumbnail.height, clampedPadding,
  );
  const fromPlan = previousRegion
    ? planRegionFraming(previousRegion, cW, cH, thumbnail.width, thumbnail.height, clampedPadding)
    : null;

  const target = targetPlan.framing;
  const from = fromPlan?.framing ?? null;

  // Spotlight clip rect at each endpoint. Full canvas means "no
  // visible clipping". Region's projected bbox at its own framing
  // produces the letterbox-around-region effect that makes the zoom
  // feel like a zoom for aspect-matched regions (clip mode).
  const fullClip = fullCanvasRect(cW, cH);
  const targetClip = targetPlan.clipMode
    ? projectBoxOnCanvas(targetPlan.paddedBox, target, cW, cH)
    : fullClip;
  const fromClip = (fromPlan?.clipMode && from)
    ? projectBoxOnCanvas(fromPlan.paddedBox, from, cW, cH)
    : fullClip;

  // One-shot diagnostic dump per scene mount. We only emit on frame 0 so
  // a 7s scene doesn't spew 210 log lines. The values here are exactly
  // what the camera math will use — if the output frame looks wrong,
  // these numbers explain why.
  if (frame === 0) {
    console.info('[thumbnail-zoom] mounted', {
      thumbnail: { w: thumbnail.width, h: thumbnail.height, url: thumbnail.imageUrl?.slice(0, 80) },
      canvas: { w: cW, h: cH },
      region: { id: region.id, label: region.label, x: region.x, y: region.y, w: region.w, h: region.h },
      previousRegionId: previousRegion?.id ?? null,
      transition: { kind: transition.kind, holdAtFullMs, zoomDurationMs, easing },
      // Phase C of plan 2026-05-20 — what padding actually got applied,
      // post-clamp. If the rendered scene looks too tight, this is the
      // first number to check.
      paddingPct: clampedPadding,
      containFraming: contain,
      targetFraming: target,
      targetTransform: framingToPixelTransform(target, cW, cH),
      // Plan 2026-05-25 — clip-mode spotlight. When `clipMode` is true
      // the camera physically can't zoom further than contain (region
      // aspect matches image aspect) and the renderer clips the canvas
      // to `targetClip` so the region still appears visually zoomed.
      // When false, no clipping is applied and the existing camera-
      // mode framing handles the zoom on its own.
      clipMode: targetPlan.clipMode,
      targetClip: targetPlan.clipMode ? targetClip : null,
    });
  }

  // Pick the framing AND clip for this frame. Both interpolate by the
  // same progress `p` so the camera position and spotlight stay in
  // sync. Branches by transition kind.
  let framing: Framing;
  let clip: CanvasRect;
  if (transition.kind === 'none') {
    // No animation at all: render the target region from frame 0. Used
    // when the creator wants an immediate cut into the section instead
    // of the hard-cut's hold-then-zoom or the smooth path's tour.
    framing = target;
    clip = targetClip;
  } else if (transition.kind === 'smooth' && from && fromPlan) {
    // Phase 1: previous-region → contain   over [0, zoomFrames)
    // Phase 2: contain → target            over [zoomFrames, 2 * zoomFrames)
    // After:   target                      held
    if (frame < zoomFrames) {
      const p = spring({ frame, fps, config: springConfig, from: 0, to: 1, durationInFrames: zoomFrames });
      framing = lerpFraming(from, contain, p);
      clip = lerpCanvasRect(fromClip, fullClip, p);
    } else if (frame < zoomFrames * 2) {
      const p = spring({ frame: frame - zoomFrames, fps, config: springConfig, from: 0, to: 1, durationInFrames: zoomFrames });
      framing = lerpFraming(contain, target, p);
      clip = lerpCanvasRect(fullClip, targetClip, p);
    } else {
      framing = target;
      clip = targetClip;
    }
  } else {
    // Hard-cut (or smooth with no prior region — degrades cleanly).
    // Phase 1: contain held for `holdFrames`
    // Phase 2: contain → target over `zoomFrames`
    // After:   target held
    if (frame < holdFrames) {
      framing = contain;
      clip = fullClip;
    } else if (frame < holdFrames + zoomFrames) {
      const p = spring({ frame: frame - holdFrames, fps, config: springConfig, from: 0, to: 1, durationInFrames: zoomFrames });
      framing = lerpFraming(contain, target, p);
      clip = lerpCanvasRect(fullClip, targetClip, p);
    } else {
      framing = target;
      clip = targetClip;
    }
  }

  const xform = framingToPixelTransform(framing, cW, cH);
  const clipInset = canvasRectToInset(clip, cW, cH);

  // Brief opening fade so the first frame doesn't pop on a black background
  // when the scene mounts. 4 frames is short enough to feel like a cut.
  // When fadeEnabled is false, skip the ramp entirely so the scene shows
  // its first computed framing immediately (rule: 'no transition at all'
  // means the very first frame is fully opaque).
  const intro = fadeEnabled
    ? interpolate(frame, [0, 4], [0, 1], {
        extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
      })
    : 1;

  // Avoid `durationInFrames` lint complaint when smooth path doesn't read it.
  void durationInFrames;

  return (
    <AbsoluteFill style={{ background: brand.backgroundColor, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: cW,
          height: cH,
          clipPath: clipInset,
          WebkitClipPath: clipInset,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: thumbnail.width,
            height: thumbnail.height,
            transform: `translate(${xform.tx}px, ${xform.ty}px) scale(${xform.scale})`,
            transformOrigin: '0 0',
            opacity: intro,
            willChange: 'transform',
          }}
        >
          <Img
            src={thumbnail.imageUrl}
            style={{
              width: thumbnail.width,
              height: thumbnail.height,
              display: 'block',
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

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

const DEFAULTS = {
  holdAtFullMs: 500,
  zoomDurationMs: 1000,
  holdAtTargetMs: 600,
  easing: 'spring-smooth' as const,
};

// Defend against zero / NaN dimensions. Division-by-zero would produce
// Infinity scale and break the render; clamp to a sane minimum.
const MIN_DIM = 1; // pixels

function containFraming(tW: number, tH: number, cW: number, cH: number): Framing {
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
 * breathing room around the region. The math inflates the region by
 * `paddingPx = max(rw, rh) * paddingPct/100` on each side before
 * computing scale, then picks the SMALLEST scale that keeps the
 * inflated rectangle inside the canvas. Focus stays at the region
 * center (we never shift away from what the user marked), clamped to
 * image bounds so the canvas keeps filling with image pixels.
 *
 *   paddingPct = 0  ⇒  byte-identical to the pre-padding contain math.
 *   paddingPct = 50 ⇒  region inflated by 50% of its longest edge on
 *                      each side — camera pulls back substantially.
 *
 * Tiny images smaller than the canvas at contain-scale still show
 * background letterbox; we don't up-rez since that would reintroduce
 * the over-zoom this fixed.
 */
function regionFraming(
  r: ThumbnailRegion,
  cW: number,
  cH: number,
  imgW: number,
  imgH: number,
  paddingPct: number,
): Framing {
  const rw = Math.max(r.w, MIN_DIM);
  const rh = Math.max(r.h, MIN_DIM);
  // Inflate the region by `paddingPct` of its longest edge so the
  // computed scale leaves breathing room around what the creator
  // marked. Using the longest edge (rather than per-axis) keeps the
  // padding visually balanced — a tall narrow region gets the same
  // absolute padding on its short axis as its long axis.
  const padPx = Math.max(0, paddingPct) * Math.max(rw, rh) / 100;
  const rwPadded = rw + 2 * padPx;
  const rhPadded = rh + 2 * padPx;
  const scale = Math.min(cW / rwPadded, cH / rhPadded);
  // Half-canvas in image-pixel units after scaling. Focus clamped to this
  // inset on each side keeps the visible canvas filled with image pixels.
  const halfW = cW / (2 * scale);
  const halfH = cH / (2 * scale);
  const minFocusX = halfW;
  const maxFocusX = Math.max(minFocusX, imgW - halfW);
  const minFocusY = halfH;
  const maxFocusY = Math.max(minFocusY, imgH - halfH);
  const wantFocusX = r.x + rw / 2;
  const wantFocusY = r.y + rh / 2;
  return {
    scale,
    focusX: Math.max(minFocusX, Math.min(maxFocusX, wantFocusX)),
    focusY: Math.max(minFocusY, Math.min(maxFocusY, wantFocusY)),
  };
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
  const target = regionFraming(region, cW, cH, thumbnail.width, thumbnail.height, clampedPadding);
  const from = previousRegion
    ? regionFraming(previousRegion, cW, cH, thumbnail.width, thumbnail.height, clampedPadding)
    : null;

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
    });
  }

  // Pick the framing for this frame. Branches by transition kind.
  let framing: Framing;
  if (transition.kind === 'none') {
    // No animation at all: render the target region from frame 0. Used
    // when the creator wants an immediate cut into the section instead
    // of the hard-cut's hold-then-zoom or the smooth path's tour.
    framing = target;
  } else if (transition.kind === 'smooth' && from) {
    // Phase 1: previous-region → contain   over [0, zoomFrames)
    // Phase 2: contain → target            over [zoomFrames, 2 * zoomFrames)
    // After:   target                      held
    if (frame < zoomFrames) {
      const p = spring({ frame, fps, config: springConfig, from: 0, to: 1, durationInFrames: zoomFrames });
      framing = lerpFraming(from, contain, p);
    } else if (frame < zoomFrames * 2) {
      const p = spring({ frame: frame - zoomFrames, fps, config: springConfig, from: 0, to: 1, durationInFrames: zoomFrames });
      framing = lerpFraming(contain, target, p);
    } else {
      framing = target;
    }
  } else {
    // Hard-cut (or smooth with no prior region — degrades cleanly).
    // Phase 1: contain held for `holdFrames`
    // Phase 2: contain → target over `zoomFrames`
    // After:   target held
    if (frame < holdFrames) {
      framing = contain;
    } else if (frame < holdFrames + zoomFrames) {
      const p = spring({ frame: frame - holdFrames, fps, config: springConfig, from: 0, to: 1, durationInFrames: zoomFrames });
      framing = lerpFraming(contain, target, p);
    } else {
      framing = target;
    }
  }

  const xform = framingToPixelTransform(framing, cW, cH);

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
    </AbsoluteFill>
  );
};

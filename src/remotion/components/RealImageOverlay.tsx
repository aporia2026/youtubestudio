import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { VideoShot } from '../types';

/**
 * Composites the auto-fetched real-image overlay on top of the scene at the
 * resolved placement zone. Renders nothing when `shot.overlay` is undefined —
 * every shot can render this safely without conditional callers.
 *
 * Layered visual treatment (plan 2026-05-18-overlay-system-overhaul):
 *   1. Container size matches the image's natural aspect ratio (read at
 *      load time). Wordmarks render as flat rectangles; portraits as tall
 *      rectangles. No more forced-square box clipping content.
 *   2. A soft ELLIPTICAL mask (radial-gradient with closest-side sizing,
 *      80%→100% stops) feathers the corners of the rectangle into the
 *      scene without ever eating logo content. The original circular mask
 *      ate edges of wide wordmarks (YAHOO, IBM); see plan for the math.
 *   3. A halo: a blurred ellipse behind the overlay, coloured by the
 *      dominant RGB of the saliency cell the overlay lands in. The halo
 *      now matches the container's aspect ratio too, so the glow tracks
 *      the actual logo silhouette.
 *   4. The placement zone itself comes from the saliency resolver in
 *      `src/lib/overlay-placement.ts` — the LLM's blind pick has already
 *      been corrected against what's actually in the image before the
 *      shot arrives here.
 *
 * Aspect resolution: we use Remotion's standard `delayRender / onLoad /
 * continueRender` pattern (per Context7 Remotion docs 2026-05-18). The
 * frame is held back until the image has loaded and `naturalWidth /
 * naturalHeight` are read into state, so every captured frame uses the
 * correct aspect. `onError` releases the delay too, so a broken image
 * URL degrades the scene to "no overlay" instead of hanging the render.
 *
 * Motion design:
 *   - 6-frame (200 ms @ 30 fps) delay after scene start so the eye lands on
 *     the main composition first, then the overlay confirms.
 *   - Opacity 0 → 1 over 12 frames (400 ms).
 *   - Scale 0.92 → 1.0 via spring (damping: 16, stiffness: 120) for a
 *     subtle, professional pop. Not bouncy.
 *
 * Size mapping is intentionally narrow (12 / 18 / 25% of frame width) —
 * the LLM should choose `large` only for hero-stamp moments where the
 * overlay IS the point.
 */

type Zone = NonNullable<VideoShot['overlay']>['zone'];
type Size = NonNullable<VideoShot['overlay']>['size'];

const SIZE_WIDTH_RATIO: Record<Size, number> = {
  small: 0.12,
  medium: 0.18,
  large: 0.25,
};

/** Inset from the frame edge as a fraction of frame width — keeps overlays
 *  off the safe-area edges where YouTube's UI / progress bar can clip. */
const EDGE_INSET = 0.04;

/** Vertical inset is a fraction of frame HEIGHT so the visual margin stays
 *  even on portrait vs. landscape compositions. */
const EDGE_INSET_V = 0.06;

/** Halo radius as a multiple of the overlay's nominal box. The blurred
 *  ellipse sits behind the overlay and extends past its edges so the
 *  overlay's "color environment" softens into the scene. */
const HALO_SCALE = 1.4;
/** Halo blur in CSS pixels at 1080p. Scales linearly with composition height. */
const HALO_BLUR_PX_AT_1080 = 32;
/** Halo opacity — high enough to read as a glow, low enough not to compete. */
const HALO_OPACITY = 0.55;

function zonePosition(
  zone: Zone,
  overlayWidthPx: number,
  overlayHeightPx: number,
  frameWidth: number,
  frameHeight: number,
): { left: number; top: number } {
  const insetX = frameWidth * EDGE_INSET;
  const insetY = frameHeight * EDGE_INSET_V;
  const centerX = (frameWidth - overlayWidthPx) / 2;
  const centerY = (frameHeight - overlayHeightPx) / 2;
  const rightX = frameWidth - overlayWidthPx - insetX;
  const bottomY = frameHeight - overlayHeightPx - insetY;

  switch (zone) {
    case 'top-left':
      return { left: insetX, top: insetY };
    case 'top-right':
      return { left: rightX, top: insetY };
    case 'bottom-left':
      return { left: insetX, top: bottomY };
    case 'bottom-right':
      return { left: rightX, top: bottomY };
    case 'center-top':
      return { left: centerX, top: insetY };
    case 'center-bottom':
      return { left: centerX, top: bottomY };
    case 'left-center':
      return { left: insetX, top: centerY };
    case 'right-center':
      return { left: rightX, top: centerY };
  }
}

/** Visual treatment for the overlay frame.
 *
 *  - 'default' (the legacy treatment): soft elliptical mask that
 *    feathers the corners, optional saliency-colored halo behind,
 *    drop shadow tracking the mask shape. Tuned for logo / wordmark
 *    overlays that need to blend into the scene rather than read as
 *    a separate sticker.
 *
 *  - 'paint-explainer-v1-frame': the "polaroid card" look — a 4px
 *    solid black rounded-rectangle border around the photo, drop
 *    shadow grounding it on the doodle canvas, no halo, no soft mask.
 *    Style-guide §5: "Real photos always framed. … like a polaroid or
 *    screen bezel. Real media never bleeds to edges." Used on
 *    paint_explainer_v1 static / hard-cut rows that carry
 *    `overlay_stock_terms` but no `real_photo_punch` motion beat;
 *    motion rows already get the polaroid via <RealPhotoPunchIn>. */
export type RealImageOverlayVariant = 'default' | 'paint-explainer-v1-frame';

interface Props {
  shot: VideoShot;
  /** Override of the area the overlay is positioned within. Defaults to
   *  the full composition. Letterbox layout passes a smaller value so
   *  the overlay stays inside the scene-below-stripe container instead
   *  of overflowing into the title stripe zone. */
  frameWidth?: number;
  frameHeight?: number;
  /** Visual treatment. Defaults to 'default' (legacy mask + halo).
   *  SceneRouter sets 'paint-explainer-v1-frame' when the doc's style
   *  is paint_explainer_v1 so non-motion shots get the genre's
   *  polaroid look without needing a parallel component. */
  variant?: RealImageOverlayVariant;
}

export const RealImageOverlay: React.FC<Props> = ({
  shot,
  frameWidth: frameWidthOverride,
  frameHeight: frameHeightOverride,
  variant = 'default',
}) => {
  const overlay = shot.overlay;
  const frame = useCurrentFrame();
  const { width: compositionWidth, height: compositionHeight, fps } = useVideoConfig();
  const frameWidth = frameWidthOverride ?? compositionWidth;
  const frameHeight = frameHeightOverride ?? compositionHeight;

  // Natural aspect ratio read from the loaded image. Null until onLoad fires;
  // delayRender holds the frame until it's known, so captured frames always
  // use the right aspect. See file header for the why.
  const [aspect, setAspect] = useState<number | null>(null);
  const [errored, setErrored] = useState(false);
  const overlayUrl = overlay?.url;

  // Track which URL the current `loadHandle` was acquired for. When the
  // URL changes (e.g., after the user accepts an AI edit and the row's
  // overlay URL swaps), we release the old handle and acquire a new
  // one so the renderer waits for the NEW image to load before
  // capturing the next frame. Without this re-acquisition, the
  // useState initialiser fires only once and a subsequent URL change
  // would leave delayRender stale → frames could be captured with the
  // OLD aspect briefly visible during the swap.
  const loadHandleRef = useRef<number | null>(null);
  const loadHandleUrlRef = useRef<string | undefined>(undefined);
  // Initial acquisition. useState init runs once; we only acquire here
  // for the very first render. Subsequent URL changes go through the
  // useEffect below.
  const [initialHandle] = useState<number | null>(() =>
    overlayUrl ? delayRender('overlay-image-load') : null,
  );
  if (loadHandleRef.current === null && loadHandleUrlRef.current === undefined && overlayUrl) {
    loadHandleRef.current = initialHandle;
    loadHandleUrlRef.current = overlayUrl;
  }

  useEffect(() => {
    // URL changed AFTER mount. Release any pending old handle (it
    // would otherwise wait forever for an Img that already unmounted)
    // and acquire a fresh one. Reset the aspect + errored state so the
    // new image's onLoad / onError actually fires the state update.
    if (loadHandleUrlRef.current === overlayUrl) return;
    if (loadHandleRef.current !== null) {
      continueRender(loadHandleRef.current);
      loadHandleRef.current = null;
    }
    if (overlayUrl) {
      loadHandleRef.current = delayRender('overlay-image-load');
      setAspect(null);
      setErrored(false);
    }
    loadHandleUrlRef.current = overlayUrl;
  }, [overlayUrl]);

  const onImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        const ratio = img.naturalWidth / img.naturalHeight;
        setAspect(ratio);
        console.info('[overlay render] aspect resolved', {
          url: overlayUrl,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          aspect: Number(ratio.toFixed(3)),
        });
      } else {
        console.warn('[overlay render] image loaded with zero dimensions — falling back to 1:1', {
          url: overlayUrl,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        });
      }
      if (loadHandleRef.current !== null) {
        continueRender(loadHandleRef.current);
        loadHandleRef.current = null;
      }
    },
    [overlayUrl],
  );

  const onImgError = useCallback(() => {
    console.warn('[overlay render] image failed to load — overlay skipped', {
      url: overlayUrl,
    });
    setErrored(true);
    if (loadHandleRef.current !== null) {
      continueRender(loadHandleRef.current);
      loadHandleRef.current = null;
    }
  }, [overlayUrl]);

  // Render nothing if there's no overlay or the image failed. After errored
  // is set, the delay handle has already been released in onImgError, so the
  // render proceeds without us. Checking `overlay` and `overlayUrl` both is
  // redundant at runtime (overlayUrl truthy ⇒ overlay defined) but lets
  // TypeScript narrow `overlay` to non-undefined for the rest of the function.
  if (!overlay || !overlayUrl || errored) return null;

  // Lag the overlay 6 frames behind the scene start so the eye registers
  // the main composition first. Without this the overlay competes for
  // attention with the Ken Burns entrance.
  const startDelay = 6;
  const relFrame = Math.max(0, frame - startDelay);

  const opacity = interpolate(relFrame, [0, 12], [0, 1], {
    extrapolateRight: 'clamp',
    extrapolateLeft: 'clamp',
  });
  const scale = spring({
    frame: relFrame,
    fps,
    config: { damping: 16, stiffness: 120, mass: 0.7 },
    from: 0.92,
    to: 1.0,
  });

  // Width resolution: a manually-set `customSizePct` (from the drag editor)
  // wins; otherwise we fall back to the zone-tier width ratio.
  const sizeRatio =
    typeof overlay.customSizePct === 'number' && Number.isFinite(overlay.customSizePct)
      ? Math.max(0.02, Math.min(0.6, overlay.customSizePct / 100))
      : SIZE_WIDTH_RATIO[overlay.size];

  // Height resolution order:
  //   1. `stretchedHeightPct` (% of frame height) — set only when the
  //      user freely stretched the overlay to a non-natural aspect in
  //      the position editor. The renderer honours the squish verbatim
  //      because that was a deliberate user choice.
  //   2. Image's natural aspect ratio (read at load time via onLoad).
  //   3. 1:1 fallback before onLoad fires. delayRender holds the frame
  //      until the real aspect is in state, so the fallback never
  //      reaches a captured frame in practice.
  //
  // Cap the height at 70% of the frame so a 1:3 portrait logo can't push
  // past the safe area; when the cap bites we shrink the width to match
  // so the container's aspect still tracks the image (the mask/halo
  // geometry depends on container aspect ≈ image aspect). The cap also
  // applies to stretchedHeightPct so a runaway drag can't fill the frame.
  const effectiveAspect = aspect ?? 1;
  let overlayWidthPx = frameWidth * sizeRatio;
  const stretchedH = overlay.stretchedHeightPct;
  let overlayHeightPx =
    typeof stretchedH === 'number' && Number.isFinite(stretchedH)
      ? (Math.max(2, Math.min(70, stretchedH)) / 100) * frameHeight
      : overlayWidthPx / effectiveAspect;
  const maxHeightPx = frameHeight * 0.7;
  if (overlayHeightPx > maxHeightPx) {
    overlayHeightPx = maxHeightPx;
    // When stretched, don't shrink width on cap — the user explicitly
    // chose this aspect and width. Only shrink width for the natural-
    // aspect path so the container's aspect still tracks the image.
    if (typeof stretchedH !== 'number') {
      overlayWidthPx = maxHeightPx * effectiveAspect;
    }
  }

  // Position resolution: a manually-set `(customX, customY)` pair wins.
  // Either alone is treated as "unset" (so partially-bad data falls back
  // to AI placement instead of jumping into a corner). The values are
  // top-left % of the frame; clamp so a drag that escaped the editor's
  // bounds can't push the overlay fully off-screen.
  let left: number;
  let top: number;
  if (
    typeof overlay.customX === 'number' &&
    typeof overlay.customY === 'number' &&
    Number.isFinite(overlay.customX) &&
    Number.isFinite(overlay.customY)
  ) {
    const clampedX = Math.max(0, Math.min(100, overlay.customX));
    const clampedY = Math.max(0, Math.min(100, overlay.customY));
    left = (clampedX / 100) * frameWidth;
    top = (clampedY / 100) * frameHeight;
  } else {
    ({ left, top } = zonePosition(
      overlay.zone,
      overlayWidthPx,
      overlayHeightPx,
      frameWidth,
      frameHeight,
    ));
  }

  const haloColor = overlay.haloColor;
  const haloBlurPx = (HALO_BLUR_PX_AT_1080 * compositionHeight) / 1080;
  // Elliptical halo: separate width and height so the glow's shape matches
  // the overlay's actual silhouette. For a wide wordmark the halo is a wide
  // ellipse, not a giant circle that bleeds far above and below the logo.
  const haloWidthPx = overlayWidthPx * HALO_SCALE;
  const haloHeightPx = overlayHeightPx * HALO_SCALE;
  const haloLeft = left + (overlayWidthPx - haloWidthPx) / 2;
  const haloTop = top + (overlayHeightPx - haloHeightPx) / 2;

  // Soft elliptical mask: `ellipse closest-side` sizes the mask so it touches
  // each side of the container, regardless of aspect ratio. The opaque core
  // extends to 80% of each axis, then fades to transparent at the edge — only
  // the outermost 20% feathers, which catches any RMBG halo residue without
  // ever eating logo content. Wide wordmarks no longer have their leftmost /
  // rightmost letters clipped by the old circular mask.
  //
  // Browsers / Chromium-in-Remotion respect both `maskImage` and the
  // non-prefixed `mask` property; we set both for safety.
  const MASK_FADE_START = 0.80; // fully opaque out to this fraction of half-axis
  const MASK_FADE_END = 1.00;   // transparent right at the box edge
  const radialMask = `radial-gradient(ellipse closest-side at center, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${MASK_FADE_START * 100}%, rgba(0,0,0,0) ${MASK_FADE_END * 100}%)`;

  // ── paint-explainer-v1-frame variant: polaroid look ───────────────
  //
  // When the doc's style is paint_explainer_v1 (passed in via the
  // `variant` prop from SceneRouter), the overlay drops the soft
  // elliptical mask and the saliency-colored halo in favour of a
  // hard 4 px rounded-rectangle frame. This matches the genre's
  // "real media always framed like a polaroid" rule (style-guide §5).
  // All the aspect / position / spring-scale math above stays the
  // same — only the inner container's compositing changes.
  if (variant === 'paint-explainer-v1-frame') {
    const FRAME_BORDER_PX = 4;
    const FRAME_CORNER_RADIUS_PX = 8;
    const FRAME_BORDER_COLOR = '#1A1A1A';
    return (
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <div
          style={{
            position: 'absolute',
            left,
            top,
            width: overlayWidthPx,
            height: overlayHeightPx,
            opacity,
            transform: `scale(${scale})`,
            transformOrigin: 'center center',
            // Hard frame: 4 px solid black border + 8 px corner radius.
            // Box-shadow grounds the polaroid against the doodle canvas
            // — same shape as the frame because box-shadow respects
            // border-radius (filter:drop-shadow would track the alpha
            // mask, which is missing here on purpose).
            border: `${FRAME_BORDER_PX}px solid ${FRAME_BORDER_COLOR}`,
            borderRadius: FRAME_CORNER_RADIUS_PX,
            background: '#FCFCFA',
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
          }}
        >
          <Img
            src={overlay.url}
            onLoad={onImgLoad}
            onError={onImgError}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {/* Halo (rendered first → behind the overlay). Only when we know
          a colour to use — without saliency data we skip it to avoid
          guessing a colour that doesn't tie to the scene. */}
      {haloColor && (
        <div
          style={{
            position: 'absolute',
            left: haloLeft,
            top: haloTop,
            width: haloWidthPx,
            height: haloHeightPx,
            borderRadius: '50%',
            background: haloColor,
            filter: `blur(${haloBlurPx}px)`,
            opacity: opacity * HALO_OPACITY,
            transform: `scale(${scale})`,
            transformOrigin: 'center center',
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width: overlayWidthPx,
          height: overlayHeightPx,
          opacity,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          // Drop shadow plus the elliptical mask. Drop shadow stays — it
          // reads as a subtle ground line even after the rectangle is
          // feathered away. Stack: the mask shapes the visible silhouette,
          // the drop shadow renders against that silhouette so the
          // shadow tracks the mask's shape too (browsers apply filter AFTER
          // mask in compositing).
          filter: 'drop-shadow(0 6px 18px rgba(0,0,0,0.30))',
          WebkitMaskImage: radialMask,
          maskImage: radialMask,
        }}
      >
        <Img
          src={overlay.url}
          onLoad={onImgLoad}
          onError={onImgError}
          style={{
            width: '100%',
            height: '100%',
            // The container now matches the image's natural aspect, so cover
            // and contain produce identical output. `cover` is the cheaper of
            // the two for the compositor and avoids any sub-pixel letterboxing
            // when aspect is rounded.
            objectFit: 'cover',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

import React from 'react';
import {
  AbsoluteFill,
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
 * Layered visual treatment (plan 2026-05-17):
 *   1. A soft circular mask + radial alpha fade replaces the hard rectangle
 *      so edges feather into the scene instead of cutting against it.
 *   2. A halo: a blurred ellipse behind the overlay, coloured by the
 *      dominant RGB of the saliency cell the overlay lands in. The
 *      overlay reads as part of the local environment, not a sticker.
 *   3. The placement zone itself comes from the saliency resolver in
 *      `src/lib/overlay-placement.ts` — the LLM's blind pick has already
 *      been corrected against what's actually in the image before the
 *      shot arrives here. Top zones are also pre-filtered out when the
 *      stripe overlaps the scene area (overlay layout).
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

interface Props {
  shot: VideoShot;
  /** Override of the area the overlay is positioned within. Defaults to
   *  the full composition. Letterbox layout passes a smaller value so
   *  the overlay stays inside the scene-below-stripe container instead
   *  of overflowing into the title stripe zone. */
  frameWidth?: number;
  frameHeight?: number;
}

export const RealImageOverlay: React.FC<Props> = ({ shot, frameWidth: frameWidthOverride, frameHeight: frameHeightOverride }) => {
  const overlay = shot.overlay;
  const frame = useCurrentFrame();
  const { width: compositionWidth, height: compositionHeight, fps } = useVideoConfig();
  const frameWidth = frameWidthOverride ?? compositionWidth;
  const frameHeight = frameHeightOverride ?? compositionHeight;

  if (!overlay?.url) return null;

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

  // Use a fixed aspect assumption (square box) for layout planning. The
  // <Img> itself uses object-fit: contain so non-square logos sit centred
  // inside the box without distortion. This keeps positions predictable
  // regardless of the actual aspect ratio of the fetched overlay.
  const overlayWidthPx = frameWidth * SIZE_WIDTH_RATIO[overlay.size];
  const overlayHeightPx = overlayWidthPx;
  const { left, top } = zonePosition(
    overlay.zone,
    overlayWidthPx,
    overlayHeightPx,
    frameWidth,
    frameHeight,
  );

  const haloColor = overlay.haloColor;
  const haloBlurPx = (HALO_BLUR_PX_AT_1080 * compositionHeight) / 1080;
  const haloSizePx = overlayWidthPx * HALO_SCALE;
  // Centre the halo on the overlay's centre, so it reads as a glow that
  // belongs TO the overlay rather than a separate blob.
  const haloLeft = left + (overlayWidthPx - haloSizePx) / 2;
  const haloTop = top + (overlayHeightPx - haloSizePx) / 2;

  // Soft circular mask: outer 18% of the radius fades to transparent so
  // the overlay's edge never produces a hard rectangle silhouette.
  // Browsers / Chromium-in-Remotion respect both `maskImage` and the
  // non-prefixed `mask` property; we set both for safety.
  const MASK_FADE_START = 0.50; // fully opaque out to this radius
  const MASK_FADE_END = 0.68;   // transparent past this radius
  const radialMask = `radial-gradient(circle at center, rgba(0,0,0,1) 0%, rgba(0,0,0,1) ${MASK_FADE_START * 100}%, rgba(0,0,0,0) ${MASK_FADE_END * 100}%)`;

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
            width: haloSizePx,
            height: haloSizePx,
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
          // Drop shadow plus the circular mask. Drop shadow stays — it
          // reads as a subtle ground line even after the rectangle is
          // feathered away. Stack: the mask shapes the visible silhouette,
          // the drop shadow renders against that silhouette so the
          // shadow itself is circular too (browsers apply filter AFTER
          // mask in compositing).
          filter: 'drop-shadow(0 6px 18px rgba(0,0,0,0.30))',
          WebkitMaskImage: radialMask,
          maskImage: radialMask,
        }}
      >
        <Img
          src={overlay.url}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

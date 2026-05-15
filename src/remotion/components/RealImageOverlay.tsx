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
 * LLM-planned zone. Renders nothing when `shot.overlay` is undefined — every
 * shot can render this safely without conditional callers.
 *
 * Motion design:
 *   - 6-frame (200 ms @ 30 fps) delay after scene start so the eye lands on
 *     the main composition first, then the overlay confirms.
 *   - Opacity 0 → 1 over 12 frames (400 ms).
 *   - Scale 0.92 → 1.0 via spring (damping: 16, stiffness: 120) for a
 *     subtle, professional pop. Not bouncy.
 *   - Drop shadow grounds the cutout in the scene.
 *
 * Zone mapping converts the LLM's semantic placement ('top-right', etc.)
 * into framing percentages. Coordinates are computed against the
 * composition width/height so the same overlay looks identical at any
 * resolution.
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
}

export const RealImageOverlay: React.FC<Props> = ({ shot }) => {
  const overlay = shot.overlay;
  const frame = useCurrentFrame();
  const { width: frameWidth, height: frameHeight, fps } = useVideoConfig();

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
          filter: 'drop-shadow(0 4px 16px rgba(0,0,0,0.35))',
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

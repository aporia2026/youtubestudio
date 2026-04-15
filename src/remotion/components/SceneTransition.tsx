import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

interface SceneTransitionProps {
  /** How many frames the fade lasts */
  durationInFrames?: number;
  /** Fade in at start */
  fadeIn?: boolean;
  /** Fade out at end of shot */
  fadeOut?: boolean;
  totalFrames?: number;
  color?: string;
}

/**
 * Overlays a fade-in / fade-out on top of a scene.
 * Wrap any scene component with this to get smooth transitions.
 */
export const SceneTransition: React.FC<SceneTransitionProps> = ({
  durationInFrames = 12,
  fadeIn = true,
  fadeOut = true,
  totalFrames = 9999,
  color = '#000000',
}) => {
  const frame = useCurrentFrame();

  let opacity = 0;

  if (fadeIn && frame < durationInFrames) {
    opacity = Math.max(opacity, interpolate(frame, [0, durationInFrames], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }));
  }

  if (fadeOut && frame > totalFrames - durationInFrames) {
    opacity = Math.max(opacity, interpolate(frame, [totalFrames - durationInFrames, totalFrames], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }));
  }

  if (opacity <= 0) return null;

  return (
    <AbsoluteFill
      style={{
        background: color,
        opacity,
        pointerEvents: 'none',
      }}
    />
  );
};

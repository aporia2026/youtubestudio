import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Img } from 'remotion';
import { VideoShot } from '../types';

interface KenBurnsProps {
  imageUrl: string;
  durationInFrames: number;
  direction?: VideoShot['kenBurnsDirection'];
  /** Extra zoom scale added on top of Ken Burns (1 = none) */
  baseScale?: number;
  /** Called when the image fails to load */
  onError?: () => void;
}

/**
 * Wraps an image in a Ken Burns (pan + subtle zoom) effect.
 * The image always fills the frame — never shows black bars.
 */
export const KenBurns: React.FC<KenBurnsProps> = ({
  imageUrl,
  durationInFrames,
  direction = 'zoom-in',
  baseScale = 1,
  onError,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateRight: 'clamp',
    extrapolateLeft: 'clamp',
  });

  // Scale goes from 1.0 → 1.08 (subtle zoom)
  const zoomStart = baseScale * 1.0;
  const zoomEnd = baseScale * 1.08;

  let scale: number;
  let translateX: number;
  let translateY: number;

  switch (direction) {
    case 'zoom-out':
      scale = interpolate(progress, [0, 1], [zoomEnd, zoomStart]);
      translateX = 0;
      translateY = 0;
      break;
    case 'pan-left':
      scale = interpolate(progress, [0, 1], [zoomStart, zoomStart * 1.05]);
      translateX = interpolate(progress, [0, 1], [0, -width * 0.03]);
      translateY = 0;
      break;
    case 'pan-right':
      scale = interpolate(progress, [0, 1], [zoomStart, zoomStart * 1.05]);
      translateX = interpolate(progress, [0, 1], [0, width * 0.03]);
      translateY = 0;
      break;
    case 'pan-up':
      scale = interpolate(progress, [0, 1], [zoomStart * 1.05, zoomStart]);
      translateX = 0;
      translateY = interpolate(progress, [0, 1], [height * 0.02, -height * 0.02]);
      break;
    case 'pan-down':
      scale = interpolate(progress, [0, 1], [zoomStart, zoomStart * 1.05]);
      translateX = 0;
      translateY = interpolate(progress, [0, 1], [0, height * 0.03]);
      break;
    case 'zoom-in':
    default:
      scale = interpolate(progress, [0, 1], [zoomStart, zoomEnd]);
      translateX = 0;
      translateY = 0;
      break;
  }

  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Img
        src={imageUrl}
        onError={onError}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${scale}) translate(${translateX}px, ${translateY}px)`,
          transformOrigin: 'center center',
          willChange: 'transform',
        }}
      />
    </AbsoluteFill>
  );
};

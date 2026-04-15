import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { SPRING_SNAPPY } from '../animations/spring-presets';
import { BrandKit } from '../types';

interface LowerThirdProps {
  text: string;
  brand: BrandKit;
  /** Position from bottom of frame, default 120px */
  bottomOffset?: number;
  /** How many frames into the scene to start the entrance */
  delay?: number;
  /** How many frames before scene end to start the exit */
  exitBeforeEnd?: number;
  totalFrames?: number;
}

/**
 * Animated lower third bar — slides in from the left.
 * Shows on-screen text overlaid on b-roll footage, educational-channel style.
 */
export const LowerThird: React.FC<LowerThirdProps> = ({
  text,
  brand,
  bottomOffset = 120,
  delay = 8,
  exitBeforeEnd = 20,
  totalFrames = 9999,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  if (!text) return null;

  // Entrance
  const entranceFrame = Math.max(0, frame - delay);
  const entrance = spring({ frame: entranceFrame, fps, config: SPRING_SNAPPY, from: 0, to: 1 });

  // Exit — slide back out
  const framesUntilEnd = totalFrames - frame;
  const isExiting = framesUntilEnd <= exitBeforeEnd;
  const exitProgress = isExiting
    ? interpolate(framesUntilEnd, [exitBeforeEnd, 0], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;

  const translateX = interpolate(entrance, [0, 1], [-width * 0.6, 0]) + exitProgress * -width * 0.6;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: bottomOffset,
        left: 60,
        transform: `translateX(${translateX}px)`,
        willChange: 'transform',
        display: 'flex',
        alignItems: 'center',
        gap: 0,
      }}
    >
      {/* Accent bar */}
      <div
        style={{
          width: 8,
          height: '100%',
          minHeight: 56,
          background: brand.primaryColor,
          borderRadius: '3px 0 0 3px',
          flexShrink: 0,
        }}
      />
      {/* Text box */}
      <div
        style={{
          background: 'rgba(0,0,0,0.82)',
          padding: '10px 24px',
          borderRadius: '0 6px 6px 0',
        }}
      >
        <span
          style={{
            fontFamily: brand.fontFamily,
            fontSize: 36,
            fontWeight: 700,
            color: '#FFFFFF',
            letterSpacing: 0.5,
            whiteSpace: 'nowrap',
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};

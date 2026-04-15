import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { BrandKit } from '../types';

interface SubtitleTextProps {
  text: string;
  brand: BrandKit;
  durationInFrames: number;
  /** Position from bottom */
  bottomOffset?: number;
  fontSize?: number;
}

/**
 * Burned-in subtitle / caption.
 * Fades in quickly, stays for the shot, fades out at the end.
 * Sits near the bottom of the frame — does NOT overlap lower thirds.
 */
export const SubtitleText: React.FC<SubtitleTextProps> = ({
  text,
  brand,
  durationInFrames,
  bottomOffset = 40,
  fontSize = 34,
}) => {
  const frame = useCurrentFrame();

  if (!text) return null;

  const opacity = interpolate(
    frame,
    [0, 6, durationInFrames - 8, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <div
      style={{
        position: 'absolute',
        bottom: bottomOffset,
        left: '50%',
        transform: 'translateX(-50%)',
        opacity,
        maxWidth: '80%',
        textAlign: 'center',
      }}
    >
      <span
        style={{
          fontFamily: brand.fontFamily,
          fontSize,
          fontWeight: 600,
          // Use white text on dark pill — readable regardless of background
          color: '#FFFFFF',
          background: brand.secondaryColor + 'CC', // 80% opacity version of brand secondary
          padding: '6px 18px',
          borderRadius: 6,
          lineHeight: 1.4,
          display: 'inline',
          boxDecorationBreak: 'clone',
          WebkitBoxDecorationBreak: 'clone',
        }}
      >
        {text}
      </span>
    </div>
  );
};

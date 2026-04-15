import React, { useState } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { KenBurns } from '../components/KenBurns';
import { LowerThird } from '../components/LowerThird';
import { FloatingElement } from '../components/FloatingElement';
import { SceneTransition } from '../components/SceneTransition';
import { VideoShot, BrandKit } from '../types';

interface BRollSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
}

// Cycle Ken Burns directions based on shot index to avoid repetition
const KB_DIRECTIONS: VideoShot['kenBurnsDirection'][] = [
  'zoom-in', 'pan-left', 'pan-right', 'zoom-out', 'pan-up', 'pan-down',
];

/**
 * B-Roll scene — image with Ken Burns motion + optional lower third.
 * When an image is available, fills the frame with it animated.
 * When no image, falls back to a stylized color background with text.
 */
export const BRollScene: React.FC<BRollSceneProps & { shotIndex?: number }> = ({
  shot,
  durationInFrames,
  brand,
  shotIndex = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [imgError, setImgError] = useState(false);

  const direction = shot.kenBurnsDirection ?? KB_DIRECTIONS[shotIndex % KB_DIRECTIONS.length];

  // No image, or image failed to load, or blob URL (expired after page reload)
  const useImage = shot.imageUrl && !imgError && !shot.imageUrl.startsWith('blob:');

  if (!useImage) {
    return <FallbackBRoll shot={shot} durationInFrames={durationInFrames} brand={brand} />;
  }

  return (
    <AbsoluteFill style={{ background: brand.backgroundColor }}>
      {/* Ken Burns image */}
      <KenBurns
        imageUrl={shot.imageUrl!}
        durationInFrames={durationInFrames}
        direction={direction}
        onError={() => setImgError(true)}
      />

      {/* Subtle dark gradient at bottom for text readability */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 220,
          background: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, transparent 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Lower third */}
      {shot.onScreenText && (
        <LowerThird
          text={shot.onScreenText}
          brand={brand}
          totalFrames={durationInFrames}
          delay={12}
          exitBeforeEnd={15}
        />
      )}

      <SceneTransition fadeIn fadeOut totalFrames={durationInFrames} durationInFrames={8} />
    </AbsoluteFill>
  );
};

// ─── Fallback when no image ────────────────────────────────────────────────────

const FallbackBRoll: React.FC<{ shot: VideoShot; durationInFrames: number; brand: BrandKit }> = ({
  shot,
  durationInFrames,
  brand,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${brand.backgroundColor} 0%, ${brand.secondaryColor}22 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px',
      }}
    >
      {/* Decorative background dots pattern */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(${brand.primaryColor}18 1px, transparent 1px)`,
          backgroundSize: '48px 48px',
          opacity: 0.5,
        }}
      />

      <div style={{ opacity, textAlign: 'center', position: 'relative', zIndex: 1 }}>
        {shot.onScreenText && (
          <div
            style={{
              fontFamily: brand.titleFontFamily,
              fontSize: 72,
              fontWeight: 800,
              color: brand.textColor,
              lineHeight: 1.2,
              letterSpacing: -2,
            }}
          >
            {shot.onScreenText}
          </div>
        )}
        {shot.scriptText && (
          <div
            style={{
              fontFamily: brand.fontFamily,
              fontSize: 40,
              fontWeight: 400,
              color: brand.textColor + 'BB',
              marginTop: 24,
              maxWidth: 900,
              lineHeight: 1.5,
            }}
          >
            {shot.scriptText.slice(0, 120)}{shot.scriptText.length > 120 ? '…' : ''}
          </div>
        )}
      </div>

      <SceneTransition fadeIn fadeOut totalFrames={durationInFrames} durationInFrames={8} />
    </AbsoluteFill>
  );
};

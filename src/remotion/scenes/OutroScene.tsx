import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Img } from 'remotion';
import { AnimatedTitle } from '../components/AnimatedTitle';
import { SceneTransition } from '../components/SceneTransition';
import { SPRING_BOUNCY, SPRING_SNAPPY } from '../animations/spring-presets';
import { VideoShot, BrandKit } from '../types';

interface OutroSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
  /** When false, suppress the scene-to-scene cross fade. Defaults `true`. */
  fadeEnabled?: boolean;
}

/**
 * Outro / End card scene.
 * Shows channel name, subscribe CTA, and optional logo.
 * Designed to hold for 5-10 seconds while YouTube shows end screen cards.
 */
export const OutroScene: React.FC<OutroSceneProps> = ({ shot, durationInFrames, brand, fadeEnabled = true }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  // Main circle pulse
  const circleSpring = spring({ frame, fps, config: SPRING_BOUNCY, from: 0, to: 1 });

  // Subscribe button slides up
  const btnSpring = spring({ frame: Math.max(0, frame - 20), fps, config: SPRING_SNAPPY, from: 0, to: 1 });
  const btnY = (1 - btnSpring) * 50;
  const btnOpacity = interpolate(Math.max(0, frame - 20), [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Rings animate outward (ripple effect)
  const ring1Progress = interpolate(frame, [10, 50], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const ring2Progress = interpolate(frame, [20, 60], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${brand.backgroundColor} 0%, ${brand.secondaryColor}11 100%)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 40,
      }}
    >
      {/* Ripple rings */}
      <RippleRing progress={ring1Progress} color={brand.primaryColor} size={320} opacity={0.15} />
      <RippleRing progress={ring2Progress} color={brand.primaryColor} size={480} opacity={0.08} />

      {/* Logo / Avatar circle */}
      <div
        style={{
          transform: `scale(${circleSpring})`,
          willChange: 'transform',
        }}
      >
        {brand.logoUrl ? (
          <Img
            src={brand.logoUrl}
            style={{
              width: 180,
              height: 180,
              borderRadius: '50%',
              objectFit: 'cover',
              border: `6px solid ${brand.primaryColor}`,
              boxShadow: `0 0 0 12px ${brand.primaryColor}22`,
            }}
          />
        ) : (
          <div
            style={{
              width: 180,
              height: 180,
              borderRadius: '50%',
              background: brand.primaryColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 72,
              fontWeight: 900,
              color: '#FFF',
              fontFamily: brand.titleFontFamily,
              boxShadow: `0 0 0 12px ${brand.primaryColor}22`,
            }}
          >
            {(brand.channelName || 'Y')[0].toUpperCase()}
          </div>
        )}
      </div>

      {/* Channel name */}
      {brand.channelName && (
        <AnimatedTitle
          text={brand.channelName}
          brand={brand}
          variant="fade"
          fontSize={72}
          delay={8}
        />
      )}

      {/* Subscribe CTA */}
      <div
        style={{
          transform: `translateY(${btnY}px)`,
          opacity: btnOpacity,
        }}
      >
        <div
          style={{
            background: brand.primaryColor,
            color: '#FFFFFF',
            fontFamily: brand.titleFontFamily,
            fontSize: 44,
            fontWeight: 800,
            padding: '20px 60px',
            borderRadius: 60,
            letterSpacing: 1,
            textTransform: 'uppercase',
            boxShadow: `0 8px 30px ${brand.primaryColor}55`,
          }}
        >
          Subscribe
        </div>
      </div>

      <SceneTransition fadeIn={fadeEnabled} fadeOut={fadeEnabled} totalFrames={durationInFrames} durationInFrames={15} color={brand.backgroundColor} />
    </AbsoluteFill>
  );
};

// ─── Ripple Ring ──────────────────────────────────────────────────────────────

const RippleRing: React.FC<{
  progress: number;
  color: string;
  size: number;
  opacity: number;
}> = ({ progress, color, size, opacity }) => (
  <div
    style={{
      position: 'absolute',
      width: size * progress,
      height: size * progress,
      borderRadius: '50%',
      border: `3px solid ${color}`,
      opacity: opacity * (1 - progress),
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'none',
    }}
  />
);

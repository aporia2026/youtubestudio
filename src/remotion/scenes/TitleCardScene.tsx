import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { AnimatedTitle } from '../components/AnimatedTitle';
import { SceneTransition } from '../components/SceneTransition';
import { SPRING_SNAPPY, SPRING_BOUNCY } from '../animations/spring-presets';
import { VideoShot, BrandKit } from '../types';

interface TitleCardSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
}

/**
 * Title Card scene — bold text on a clean background.
 * Used for video intro, section headers, chapter titles.
 * Style matches educational YouTube channels (WannaCry, ILOVEYOU style).
 */
export const TitleCardScene: React.FC<TitleCardSceneProps> = ({
  shot,
  durationInFrames,
  brand,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Accent bar slides in from left
  const barWidth = spring({ frame, fps, config: SPRING_SNAPPY, from: 0, to: width * 0.6 });
  const barOpacity = interpolate(frame, [0, 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Subtitle slides up with delay
  const subtitleSpring = spring({ frame: Math.max(0, frame - 12), fps, config: SPRING_SNAPPY, from: 0, to: 1 });
  const subtitleY = (1 - subtitleSpring) * 40;
  const subtitleOpacity = interpolate(Math.max(0, frame - 12), [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const bg = shot.backgroundColor || brand.backgroundColor;

  return (
    <AbsoluteFill style={{ background: bg }}>

      {/* Decorative top accent bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: barWidth,
          height: 12,
          background: brand.primaryColor,
          opacity: barOpacity,
        }}
      />

      {/* Decorative bottom accent bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: barWidth,
          height: 12,
          background: brand.primaryColor,
          opacity: barOpacity,
        }}
      />

      {/* Center content */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px 120px',
          gap: 32,
        }}
      >
        {shot.title && (
          <AnimatedTitle
            text={shot.title}
            brand={brand}
            variant="slide-up"
            fontSize={96}
            uppercase={false}
          />
        )}

        {shot.subtitle && (
          <div
            style={{
              fontFamily: brand.fontFamily,
              fontSize: 48,
              fontWeight: 500,
              color: brand.textColor,
              textAlign: 'center',
              opacity: subtitleOpacity,
              transform: `translateY(${subtitleY}px)`,
              letterSpacing: -0.5,
              maxWidth: '80%',
            }}
          >
            {shot.subtitle}
          </div>
        )}

        {/* Accent line under title */}
        <div
          style={{
            height: 6,
            width: barWidth * 0.3,
            background: brand.primaryColor,
            borderRadius: 3,
            opacity: barOpacity,
          }}
        />
      </div>

      <SceneTransition fadeIn fadeOut totalFrames={durationInFrames} durationInFrames={10} />
    </AbsoluteFill>
  );
};

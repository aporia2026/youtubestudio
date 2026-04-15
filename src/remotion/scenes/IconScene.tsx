import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Img } from 'remotion';
import { AnimatedTitle } from '../components/AnimatedTitle';
import { FloatingElement } from '../components/FloatingElement';
import { SceneTransition } from '../components/SceneTransition';
import { SPRING_BOUNCY, SPRING_SNAPPY } from '../animations/spring-presets';
import { VideoShot, BrandKit } from '../types';

interface IconSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
}

/**
 * Icon/Illustration scene — matches the flat 2D cartoon style in the reference images.
 * White background, bold title at top, illustration centered with floating animation.
 * Entrance: image bounces in from below, title slides down from above.
 */
export const IconScene: React.FC<IconSceneProps> = ({ shot, durationInFrames, brand }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();

  // Image bounces in from below
  const imgSpring = spring({ frame: Math.max(0, frame - 5), fps, config: SPRING_BOUNCY, from: 0, to: 1 });
  const imgY = (1 - imgSpring) * 120;
  const imgScale = 0.6 + imgSpring * 0.4;
  const imgOpacity = interpolate(Math.max(0, frame - 5), [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Red accent lines animate in (like in the ILOVEYOU reference images)
  const accentSpring = spring({ frame: Math.max(0, frame - 15), fps, config: SPRING_SNAPPY, from: 0, to: 1 });

  const bg = shot.backgroundColor || brand.backgroundColor;

  return (
    <AbsoluteFill style={{ background: bg }}>

      {/* Title at top — slides down */}
      <div
        style={{
          position: 'absolute',
          top: 80,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        {shot.title && (
          <AnimatedTitle
            text={shot.title}
            brand={brand}
            variant="slide-down"
            fontSize={90}
            uppercase={false}
            shadow={false}
          />
        )}
      </div>

      {/* Main illustration — centered, floating */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: shot.title ? 120 : 0,
        }}
      >
        {shot.imageUrl ? (
          <FloatingElement style="float" amplitude={12} speed={0.45}>
            <div
              style={{
                transform: `translateY(${imgY}px) scale(${imgScale})`,
                opacity: imgOpacity,
                willChange: 'transform, opacity',
              }}
            >
              <Img
                src={shot.imageUrl}
                style={{
                  maxWidth: 800,
                  maxHeight: 580,
                  objectFit: 'contain',
                  // Drop shadow to lift illustration off the background
                  filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.12))',
                }}
              />
            </div>
          </FloatingElement>
        ) : (
          <PlaceholderIllustration brand={brand} text={shot.subtitle || shot.onScreenText || ''} />
        )}
      </div>

      {/* Accent detail — thin colored line at bottom, grows in */}
      <div
        style={{
          position: 'absolute',
          bottom: 60,
          left: '50%',
          transform: `translateX(-50%) scaleX(${accentSpring})`,
          transformOrigin: 'center',
          width: 120,
          height: 5,
          background: brand.primaryColor,
          borderRadius: 3,
        }}
      />

      <SceneTransition
        fadeIn
        fadeOut
        totalFrames={durationInFrames}
        durationInFrames={10}
        color={bg}
      />
    </AbsoluteFill>
  );
};

// ─── Placeholder when no image ─────────────────────────────────────────────────

const PlaceholderIllustration: React.FC<{ brand: BrandKit; text: string }> = ({ brand, text }) => (
  <div
    style={{
      width: 400,
      height: 400,
      borderRadius: '50%',
      border: `12px solid ${brand.primaryColor}33`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      padding: 48,
    }}
  >
    <span
      style={{
        fontFamily: brand.titleFontFamily,
        fontSize: 52,
        fontWeight: 700,
        color: brand.textColor,
        lineHeight: 1.3,
      }}
    >
      {text}
    </span>
  </div>
);

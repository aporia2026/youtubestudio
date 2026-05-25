import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Img } from 'remotion';
import { KenBurns } from '../components/KenBurns';
import { LowerThird, type LowerThirdVariant } from '../components/LowerThird';
import { SceneTransition } from '../components/SceneTransition';
import { SPRING_SMOOTH } from '../animations/spring-presets';
import { VideoShot, BrandKit } from '../types';

interface ScreenMockupSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
  /** When true, skip the lower-third on-screen-text overlay. See
   *  BRollScene for the same flag and its rationale. */
  suppressLowerThird?: boolean;
  /** When false, suppress the scene-to-scene cross fade. Defaults `true`. */
  fadeEnabled?: boolean;
  /** Glyph treatment for the LowerThird `onScreenText` overlay. See
   *  the same prop on BRollScene + Phase 2 plan. Defaults to 'default'. */
  lowerThirdVariant?: LowerThirdVariant;
}

/**
 * Screen Mockup scene — shows a UI screenshot in a stylized monitor/browser frame.
 * Slides in from below and slightly zooms/pans to guide attention.
 */
export const ScreenMockupScene: React.FC<ScreenMockupSceneProps> = ({
  shot,
  durationInFrames,
  brand,
  suppressLowerThird = false,
  fadeEnabled = true,
  lowerThirdVariant = 'default',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const slideSpring = spring({ frame, fps, config: SPRING_SMOOTH, from: 0, to: 1 });
  const slideY = (1 - slideSpring) * 80;
  const scaleValue = 0.92 + slideSpring * 0.08;
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const bg = shot.backgroundColor || brand.backgroundColor;

  return (
    <AbsoluteFill
      style={{
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Background pattern */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `linear-gradient(${brand.primaryColor}08 1px, transparent 1px), linear-gradient(90deg, ${brand.primaryColor}08 1px, transparent 1px)`,
          backgroundSize: '60px 60px',
        }}
      />

      {/* Monitor frame */}
      <div
        style={{
          transform: `translateY(${slideY}px) scale(${scaleValue})`,
          opacity,
          willChange: 'transform, opacity',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 0,
        }}
      >
        {/* Browser chrome */}
        <div
          style={{
            width: 1200,
            background: '#2D2D2D',
            borderRadius: '12px 12px 0 0',
            padding: '14px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {/* Traffic lights */}
          {['#FF5F57', '#FEBC2E', '#28C840'].map((c, i) => (
            <div key={i} style={{ width: 14, height: 14, borderRadius: '50%', background: c }} />
          ))}
          {/* URL bar */}
          <div
            style={{
              flex: 1,
              background: '#404040',
              borderRadius: 6,
              height: 28,
              marginLeft: 12,
            }}
          />
        </div>

        {/* Screen content */}
        <div
          style={{
            width: 1200,
            height: 680,
            background: '#fff',
            borderRadius: '0 0 8px 8px',
            overflow: 'hidden',
            border: '2px solid #1A1A1A',
            borderTop: 'none',
            position: 'relative',
          }}
        >
          {shot.imageUrl ? (
            <KenBurns
              imageUrl={shot.imageUrl}
              durationInFrames={durationInFrames}
              direction="zoom-in"
              baseScale={1.02}
            />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#F5F5F5',
              }}
            >
              <span style={{
                fontFamily: brand.fontFamily,
                fontSize: 40,
                color: '#999',
                fontWeight: 500,
              }}>
                Screen Recording
              </span>
            </div>
          )}
        </div>

        {/* Monitor stand */}
        <div style={{ width: 140, height: 20, background: '#333', marginTop: 0, borderRadius: '0 0 4px 4px' }} />
        <div style={{ width: 220, height: 14, background: '#2A2A2A', borderRadius: 4 }} />
      </div>

      {shot.onScreenText && !suppressLowerThird && (
        <LowerThird
          text={shot.onScreenText}
          brand={brand}
          totalFrames={durationInFrames}
          delay={18}
          exitBeforeEnd={15}
          variant={lowerThirdVariant}
        />
      )}

      <SceneTransition fadeIn={fadeEnabled} fadeOut={fadeEnabled} totalFrames={durationInFrames} durationInFrames={10} color={bg} />
    </AbsoluteFill>
  );
};

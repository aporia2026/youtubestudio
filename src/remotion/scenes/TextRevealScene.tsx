import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { SceneTransition } from '../components/SceneTransition';
import { SPRING_SNAPPY } from '../animations/spring-presets';
import { VideoShot, BrandKit } from '../types';

interface TextRevealSceneProps {
  shot: VideoShot;
  durationInFrames: number;
  brand: BrandKit;
  /** When false, suppress the scene-to-scene cross fade. Defaults `true`. */
  fadeEnabled?: boolean;
}

/**
 * Text-only scene — reveals lines of text sequentially.
 * Great for stats, quotes, facts, key points.
 * Each word/chunk animates in independently.
 */
export const TextRevealScene: React.FC<TextRevealSceneProps> = ({
  shot,
  durationInFrames,
  brand,
  fadeEnabled = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const text = shot.onScreenText || shot.scriptText || '';
  const lines = text.split(/\r\n|\n|•|·/).map(l => l.trim()).filter(Boolean);

  // If we have a short single line, render it as a bold statement
  const isBoldStatement = lines.length === 1 && lines[0].length < 60;

  const bg = shot.backgroundColor || brand.backgroundColor;

  return (
    <AbsoluteFill
      style={{
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 120px',
        flexDirection: 'column',
        gap: 32,
      }}
    >
      {/* Background accent */}
      <BackgroundAccent brand={brand} frame={frame} />

      {isBoldStatement ? (
        <BoldStatement text={lines[0]} brand={brand} frame={frame} fps={fps} />
      ) : (
        <LineReveal lines={lines} brand={brand} frame={frame} fps={fps} durationInFrames={durationInFrames} />
      )}

      <SceneTransition fadeIn={fadeEnabled} fadeOut={fadeEnabled} totalFrames={durationInFrames} durationInFrames={10} color={bg} />
    </AbsoluteFill>
  );
};

// ─── Bold statement — single impactful line ────────────────────────────────────

const BoldStatement: React.FC<{ text: string; brand: BrandKit; frame: number; fps: number }> = ({
  text, brand, frame, fps,
}) => {
  const scaleSpring = spring({ frame, fps, config: SPRING_SNAPPY, from: 0.8, to: 1 });
  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Highlight color sweeps across the text
  const highlightWidth = interpolate(frame, [8, 28], [0, 100], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div style={{ position: 'relative', textAlign: 'center' }}>
      {/* Highlight bar behind text */}
      <div
        style={{
          position: 'absolute',
          bottom: 4,
          left: 0,
          height: '35%',
          width: `${highlightWidth}%`,
          background: brand.primaryColor + '40',
          borderRadius: 4,
          transition: 'none',
        }}
      />
      <span
        style={{
          fontFamily: brand.titleFontFamily,
          fontSize: 100,
          fontWeight: 900,
          color: brand.titleColor,
          letterSpacing: -3,
          lineHeight: 1.1,
          transform: `scale(${scaleSpring})`,
          opacity,
          display: 'inline-block',
          position: 'relative',
        }}
      >
        {text}
      </span>
    </div>
  );
};

// ─── Multi-line sequential reveal ─────────────────────────────────────────────

const LineReveal: React.FC<{
  lines: string[];
  brand: BrandKit;
  frame: number;
  fps: number;
  durationInFrames: number;
}> = ({ lines, brand, frame, fps, durationInFrames }) => {
  const framesPerLine = Math.floor((durationInFrames - 20) / Math.max(lines.length, 1));

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        width: '100%',
        maxWidth: 1400,
      }}
    >
      {lines.map((line, i) => {
        const lineStart = 8 + i * framesPerLine;
        const lineFrame = Math.max(0, frame - lineStart);
        const lineSpring = spring({ frame: lineFrame, fps, config: SPRING_SNAPPY, from: 0, to: 1 });
        const lineOpacity = interpolate(lineFrame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const lineX = (1 - lineSpring) * -60;

        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 20,
              transform: `translateX(${lineX}px)`,
              opacity: lineOpacity,
            }}
          >
            {/* Bullet */}
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: brand.primaryColor,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontFamily: brand.fontFamily,
                fontSize: 52,
                fontWeight: 600,
                color: brand.textColor,
                lineHeight: 1.3,
              }}
            >
              {line}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// ─── Subtle background accent ──────────────────────────────────────────────────

const BackgroundAccent: React.FC<{ brand: BrandKit; frame: number }> = ({ brand, frame }) => {
  const opacity = interpolate(frame, [0, 20], [0, 0.06], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        position: 'absolute',
        top: -200,
        right: -200,
        width: 600,
        height: 600,
        borderRadius: '50%',
        background: brand.primaryColor,
        opacity,
        pointerEvents: 'none',
        filter: 'blur(80px)',
      }}
    />
  );
};

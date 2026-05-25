import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { SPRING_SNAPPY } from '../animations/spring-presets';
import { BrandKit } from '../types';
import { LILITA_ONE_FAMILY } from '../fonts-registry';

/** Glyph treatment for the lower-third text. Scenes pick this from
 *  the active production-doc style — Phase 2 of
 *  `_plans/2026-05-25-style-aware-overlay-text.md`.
 *
 *   - 'default'      classic dark text box + accent bar (every other style)
 *   - 'doodle-yellow' chunky yellow bubble glyphs with black outline,
 *                    no background box (doodle_explainer_2)
 */
export type LowerThirdVariant = 'default' | 'doodle-yellow';

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
  /** Visual treatment. Defaults to 'default' so every existing caller
   *  keeps producing the classic dark-box lower-third unchanged. */
  variant?: LowerThirdVariant;
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
  variant = 'default',
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  if (!text) return null;

  // Entrance + exit animation envelope is SHARED across variants so the
  // doodle-yellow variant gets the same enter/exit feel as the default
  // dark-box treatment — only the glyph styling diverges.
  const entranceFrame = Math.max(0, frame - delay);
  const entrance = spring({ frame: entranceFrame, fps, config: SPRING_SNAPPY, from: 0, to: 1 });

  // Exit — slide back out as the scene approaches its end.
  // framesUntilEnd counts DOWN from totalFrames to 0, so to keep interpolate's
  // inputRange strictly increasing (Remotion throws otherwise) we flip both
  // ranges: at framesUntilEnd=0 we want progress=1 (fully exited); at
  // framesUntilEnd=exitBeforeEnd we want progress=0 (haven't started).
  const framesUntilEnd = totalFrames - frame;
  const isExiting = framesUntilEnd <= exitBeforeEnd;
  const exitProgress = isExiting
    ? interpolate(framesUntilEnd, [0, exitBeforeEnd], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;

  const isMultiLine = text.includes('\n');

  if (variant === 'doodle-yellow') {
    // Center-aligned chunky yellow bubble text with thin black outline.
    // No background box (the source videos float the text directly on
    // the white background). Same enter/exit timing as 'default', just
    // a different translate axis: slide UP from below the frame rather
    // than IN from the left side, since center alignment makes a
    // sideways slide look off-axis.
    const translateY =
      interpolate(entrance, [0, 1], [width * 0.05, 0]) + exitProgress * width * 0.05;
    const opacity = interpolate(entrance, [0, 1], [0, 1]) * (1 - exitProgress);
    const fontSize = isMultiLine ? 60 : 76;
    return (
      <div
        style={{
          position: 'absolute',
          bottom: bottomOffset,
          left: 0,
          right: 0,
          transform: `translateY(${translateY}px)`,
          opacity,
          willChange: 'transform, opacity',
          textAlign: 'center',
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            fontFamily: LILITA_ONE_FAMILY,
            fontWeight: 400,
            fontSize,
            // Yellow fill matching the reference videos
            // (v2_t028 / v2_t075). Slightly warm, not pure web yellow.
            color: '#FCD34D',
            letterSpacing: 1,
            lineHeight: isMultiLine ? 1.15 : 1,
            whiteSpace: isMultiLine ? 'pre-line' : 'nowrap',
            // Thin black outline. -webkit-text-stroke is the supported
            // path in Chromium (Remotion's renderer + Studio preview);
            // text-shadow is the visual fallback that also adds a
            // subtle drop shadow grounding the text against the white
            // background of doodle-style frames.
            WebkitTextStroke: '2px #000000',
            textShadow:
              '2px 2px 0 rgba(0,0,0,0.18), 0 0 1px #000, 0 0 1px #000',
            // Paint stroke under the fill so the yellow stays clean
            // (without this the stroke can muddy the inner color on
            // certain rasterizers).
            paintOrder: 'stroke fill',
          }}
        >
          {text}
        </span>
      </div>
    );
  }

  // Default variant — original behavior unchanged.
  const translateX = interpolate(entrance, [0, 1], [-width * 0.6, 0]) + exitProgress * -width * 0.6;

  // Multi-line text (e.g. stacked stats) needs the bar to stretch with
  // the text box, slightly smaller type, and pre-line so \n is honored.
  // Single-line text keeps the original nowrap behavior so long titles
  // don't wrap awkwardly across the lower-third bar.
  return (
    <div
      style={{
        position: 'absolute',
        bottom: bottomOffset,
        left: 60,
        transform: `translateX(${translateX}px)`,
        willChange: 'transform',
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
      }}
    >
      {/* Accent bar */}
      <div
        style={{
          width: 8,
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
          padding: isMultiLine ? '14px 24px' : '10px 24px',
          borderRadius: '0 6px 6px 0',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontFamily: brand.fontFamily,
            fontSize: isMultiLine ? 32 : 36,
            fontWeight: 700,
            color: '#FFFFFF',
            letterSpacing: 0.5,
            whiteSpace: isMultiLine ? 'pre-line' : 'nowrap',
            lineHeight: isMultiLine ? 1.25 : 1,
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};

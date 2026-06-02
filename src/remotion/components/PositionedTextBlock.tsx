import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { SPRING_SNAPPY } from '../animations/spring-presets';
import { LILITA_ONE_FAMILY } from '../fonts-registry';
import type { BrandKit } from '../types';
import type { OnScreenTextBlock } from '../utils';

/**
 * Render a single `OnScreenTextBlock` at its block-defined position.
 *
 * PR 6 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
 *
 * Distinct from `<LowerThird>` (which has fixed bottom-anchored
 * geometry + slide-in-from-left animation), this component:
 *   - Positions at the block's x_pct / y_pct as a percentage of the
 *     canvas, with anchor controlling which point of the block sits
 *     at that coordinate.
 *   - Applies block.scale to fontSize and block.rotation_deg.
 *   - Uses a uniform fade + lift entrance (no per-anchor slide
 *     direction) so blocks placed at any position read consistently.
 *
 * Variant glyph styling mirrors LowerThird's two presets (default
 * dark-card vs doodle-yellow chunky letters) so a doc that picks
 * the yellow variant for one block gets the exact same paint
 * treatment LowerThird would render.
 */

interface PositionedTextBlockProps {
  block: OnScreenTextBlock;
  brand: BrandKit;
  totalFrames: number;
  /** Resolved variant for this shot — used when block.variant is
   *  undefined (block inherits the doc's variant). Mirrors
   *  SceneRouter's resolution. */
  fallbackVariant: 'default' | 'doodle-yellow';
  /** Entrance + exit animation envelope timing, in frames. */
  delay?: number;
  exitBeforeEnd?: number;
}

const ANCHOR_TRANSFORM_ORIGIN: Record<
  NonNullable<OnScreenTextBlock['anchor']>,
  string
> = {
  'top-left': '0% 0%',
  'top-center': '50% 0%',
  'top-right': '100% 0%',
  'center-left': '0% 50%',
  'center': '50% 50%',
  'center-right': '100% 50%',
  'bottom-left': '0% 100%',
  'bottom-center': '50% 100%',
  'bottom-right': '100% 100%',
};

/** Translate offsets so the block's `anchor` lands at (x_pct, y_pct).
 *  e.g. anchor='center' shifts -50% on both axes; anchor='top-left'
 *  shifts 0; anchor='bottom-right' shifts -100% on both. */
const ANCHOR_TRANSLATE: Record<
  NonNullable<OnScreenTextBlock['anchor']>,
  { x: string; y: string }
> = {
  'top-left':      { x: '0%',    y: '0%' },
  'top-center':    { x: '-50%',  y: '0%' },
  'top-right':     { x: '-100%', y: '0%' },
  'center-left':   { x: '0%',    y: '-50%' },
  'center':        { x: '-50%',  y: '-50%' },
  'center-right':  { x: '-100%', y: '-50%' },
  'bottom-left':   { x: '0%',    y: '-100%' },
  'bottom-center': { x: '-50%',  y: '-100%' },
  'bottom-right':  { x: '-100%', y: '-100%' },
};

export const PositionedTextBlock: React.FC<PositionedTextBlockProps> = ({
  block,
  brand: _brand,
  totalFrames,
  fallbackVariant,
  delay = 8,
  exitBeforeEnd = 20,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!block.text) return null;

  // Entrance: fade + slight lift (uniform across anchors).
  const entranceFrame = Math.max(0, frame - delay);
  const entrance = spring({
    frame: entranceFrame,
    fps,
    config: SPRING_SNAPPY,
    from: 0,
    to: 1,
  });
  const framesUntilEnd = totalFrames - frame;
  const isExiting = framesUntilEnd <= exitBeforeEnd;
  const exitProgress = isExiting
    ? interpolate(framesUntilEnd, [0, exitBeforeEnd], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 0;
  const opacity = interpolate(entrance, [0, 1], [0, 1]) * (1 - exitProgress);
  const liftPx = interpolate(entrance, [0, 1], [12, 0]);

  const anchor = block.anchor ?? 'center';
  const tr = ANCHOR_TRANSLATE[anchor];
  const variant = block.variant ?? fallbackVariant;
  const isMultiLine = block.text.includes('\n');

  // Glyph styling — mirrors LowerThird's two variants verbatim so the
  // visual matches whether a row uses legacy single-text or new blocks.
  const baseFontSize =
    variant === 'doodle-yellow'
      ? (isMultiLine ? 60 : 76)
      : (isMultiLine ? 56 : 72);
  const fontSize = baseFontSize * block.scale;
  const rotation = block.rotation_deg ?? 0;

  const isDoodleYellow = variant === 'doodle-yellow';
  const innerStyle: React.CSSProperties = isDoodleYellow
    ? {
        fontFamily: LILITA_ONE_FAMILY,
        fontWeight: 400,
        fontSize,
        color: '#FCD34D',
        letterSpacing: 1,
        lineHeight: isMultiLine ? 1.15 : 1,
        whiteSpace: isMultiLine ? 'pre-line' : 'nowrap',
        WebkitTextStroke: '2px #000000',
        textShadow: '2px 2px 0 rgba(0,0,0,0.18), 0 0 1px #000, 0 0 1px #000',
        paintOrder: 'stroke fill',
      }
    : {
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontWeight: 700,
        fontSize,
        color: '#FFFFFF',
        letterSpacing: 0.5,
        lineHeight: isMultiLine ? 1.15 : 1,
        whiteSpace: isMultiLine ? 'pre-line' : 'nowrap',
        background: 'rgba(0,0,0,0.78)',
        padding: '8px 16px',
        borderLeft: '4px solid #ef4444',
        borderRadius: 2,
        display: 'inline-block',
      };

  return (
    <div
      style={{
        position: 'absolute',
        left: `${block.x_pct}%`,
        top: `${block.y_pct}%`,
        transform: `translate(${tr.x}, ${tr.y}) translateY(${liftPx}px) rotate(${rotation}deg)`,
        transformOrigin: ANCHOR_TRANSFORM_ORIGIN[anchor],
        opacity,
        willChange: 'transform, opacity',
        pointerEvents: 'none',
      }}
      aria-hidden
    >
      <span style={innerStyle}>{block.text}</span>
    </div>
  );
};

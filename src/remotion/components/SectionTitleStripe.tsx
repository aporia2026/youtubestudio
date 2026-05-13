import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { PATRICK_HAND_FAMILY } from '../fonts';
import type { BrandKit } from '../types';

/**
 * Fixed white band at the top of the frame showing a section's title.
 * Reusable across any scene — wherever `shot.sectionTitle` is set in
 * the YouTubeVideo composition, this overlay renders for that shot's
 * full duration.
 *
 * Type style: Patrick Hand (whiteboard / friendly-explainer aesthetic).
 * Falls back to the brand kit's title font when Patrick Hand fails to
 * load (the font loader degrades gracefully — see `src/remotion/fonts.ts`).
 *
 * Enters with a brief slide-down + opacity fade so it lands deliberately
 * at the start of the shot rather than popping in cold. Exit is implicit
 * via the Sequence boundary.
 */
interface SectionTitleStripeProps {
  text: string;
  brand: BrandKit;
  /** Stripe height as a fraction of frame height. Default 0.13 (~140px at 1080p).
   *  Clamped to [0.06, 0.22] to avoid invisible / overwhelming bands. */
  heightFraction?: number;
}

const MIN_FRACTION = 0.06;
const MAX_FRACTION = 0.22;
const DEFAULT_FRACTION = 0.13;

function clampFraction(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_FRACTION;
  return Math.max(MIN_FRACTION, Math.min(MAX_FRACTION, v));
}

export const SectionTitleStripe: React.FC<SectionTitleStripeProps> = ({
  text,
  brand,
  heightFraction,
}) => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();

  // 10-frame fade + slide-down on entry. After that, the stripe is locked.
  const opacity = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const translateY = interpolate(frame, [0, 12], [-30, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const stripeHeight = height * clampFraction(heightFraction);
  // Title sized so a long label still fits; pad for shorter labels reads as
  // generous. ~52% of stripe height gives a tight optical center.
  const fontSize = Math.round(stripeHeight * 0.52);

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: stripeHeight,
        background: '#FFFFFF',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.10)',
        opacity,
        transform: `translateY(${translateY}px)`,
        // Sit above the scene contents, including any zoom transforms.
        zIndex: 5,
        // Don't intercept events — irrelevant on render but useful in Studio preview.
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          fontFamily: `'${PATRICK_HAND_FAMILY}', ${brand.titleFontFamily}`,
          fontSize,
          fontWeight: 400,
          color: brand.titleColor || '#111111',
          // Patrick Hand's metrics put descenders below the baseline; nudge up so
          // the optical center lands in the middle of the stripe.
          lineHeight: 1,
          paddingBottom: Math.round(stripeHeight * 0.05),
          maxWidth: '90%',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          letterSpacing: 0.5,
        }}
      >
        {text}
      </span>
    </div>
  );
};

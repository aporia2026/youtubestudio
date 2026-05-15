import React from 'react';
import { useVideoConfig } from 'remotion';
import { PATRICK_HAND_FAMILY } from '../fonts';
import type { BrandKit } from '../types';

/**
 * Fixed white band at the top of the frame showing a section's title.
 *
 * The YouTubeVideo composition groups consecutive shots that share the
 * same `sectionTitle` and wraps each group in a single Sequence around
 * this component, so the stripe stays mounted across scene transitions
 * within the same section — no re-entrance flicker. It's a pure static
 * band: no entrance animation, no exit animation. Just present for the
 * duration of its Sequence.
 *
 * Type style: Patrick Hand (whiteboard / friendly-explainer aesthetic).
 * Falls back to the brand kit's title font when Patrick Hand fails to
 * load (the font loader degrades gracefully — see `src/remotion/fonts.ts`).
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

/** Resolve a stripe-height fraction to its clamped value. Exported so the
 *  composition can compute the same stripe pixel height it'll render and
 *  use it as the top offset for the scene container below. */
export function clampSectionStripeFraction(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_FRACTION;
  return Math.max(MIN_FRACTION, Math.min(MAX_FRACTION, v));
}

export const SectionTitleStripe: React.FC<SectionTitleStripeProps> = ({
  text,
  brand,
  heightFraction,
}) => {
  const { height } = useVideoConfig();
  const stripeHeight = height * clampSectionStripeFraction(heightFraction);
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

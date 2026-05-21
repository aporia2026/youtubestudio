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

// Stripe-geometry constants + clamp helper moved to a pure-TS module so
// server-only libs can import the clamp without pulling React into the
// bundle. Re-export here so any existing client-side caller that
// imported `clampSectionStripeFraction` from this file keeps working.
export {
  clampSectionStripeFraction,
  SECTION_STRIPE_MIN_FRACTION,
  SECTION_STRIPE_MAX_FRACTION,
  SECTION_STRIPE_DEFAULT_FRACTION,
} from '../utils/section-stripe';
import { clampSectionStripeFraction } from '../utils/section-stripe';

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
          // Line-height has to be tall enough to contain descenders
          // (g, j, p, q, y). With lineHeight: 1 the line box ends exactly
          // at the baseline, and combined with `overflow: hidden` below
          // (kept so long titles can ellipsis) the descenders get clipped.
          // 1.3 is the conventional minimum that fits descenders cleanly
          // for hand-drawn fonts whose descenders run deeper than serif
          // norms (Patrick Hand is one of those). Centering still works
          // because the flex parent vertical-aligns the whole line box.
          lineHeight: 1.3,
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

/**
 * Pure-TS helpers + constants for the section-title stripe geometry.
 *
 * Extracted from `src/remotion/components/SectionTitleStripe.tsx` so
 * server-only libs (e.g. `src/lib/render-canvas.ts`, consumed by
 * `/api/generate/production-doc/image`) can import the clamping helper
 * without pulling React + Remotion's `useVideoConfig` into the server
 * bundle. The .tsx component re-exports these so its public surface
 * stays unchanged.
 */

export const SECTION_STRIPE_MIN_FRACTION = 0.06;
export const SECTION_STRIPE_MAX_FRACTION = 0.22;
export const SECTION_STRIPE_DEFAULT_FRACTION = 0.13;

/** Resolve a stripe-height fraction to its clamped value. Used by the
 *  Remotion composition AND the server-side image-canvas resolver so
 *  both compute the same effective stripe height from the same raw
 *  fraction input. */
export function clampSectionStripeFraction(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return SECTION_STRIPE_DEFAULT_FRACTION;
  }
  return Math.max(SECTION_STRIPE_MIN_FRACTION, Math.min(SECTION_STRIPE_MAX_FRACTION, v));
}

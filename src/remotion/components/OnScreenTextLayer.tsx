import React from 'react';
import { LowerThird, type LowerThirdVariant } from './LowerThird';
import { PositionedTextBlock } from './PositionedTextBlock';
import type { VideoShot, BrandKit } from '../types';

/**
 * Unified mount-point for a shot's on-screen text overlay(s).
 *
 * PR 6 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
 *
 * Two paths, chosen by data shape (NOT by feature flag — both paths
 * coexist in every doc, picked per-shot):
 *
 *   - When `shot.onScreenTextBlocks` is set + non-empty → iterate each
 *     block and mount `<PositionedTextBlock>` per entry. Multiple
 *     overlays at arbitrary canvas positions, per-block variant + scale
 *     + rotation. The PR 5 inspector populates this field; the PR 6
 *     drag layer (in the editor) mutates the position values.
 *
 *   - Else → mount a single `<LowerThird>` driven by `shot.onScreenText`.
 *     This is the legacy code path; every existing project hits this
 *     branch and renders byte-identical to before this PR.
 *
 * Suppression: callers pass `suppressLowerThird` (the doc's
 * suppressLowerThirds flag, optionally overridden per-shot). When true,
 * BOTH paths render nothing — the user has opted out of OST overlays
 * either via the doc-level toggle or because the row's OST mode is
 * `'bake'` / `'none'` (resolved in `productionDocToVideoConfig`).
 */

interface OnScreenTextLayerProps {
  shot: VideoShot;
  brand: BrandKit;
  durationInFrames: number;
  /** When true, render nothing. Mirrors the previous gate in every
   *  scene (`{shot.onScreenText && !suppressLowerThird && ...}`). */
  suppressLowerThird?: boolean;
  /** Doc-resolved variant for this shot's lower-thirds. Used by both
   *  the legacy LowerThird path and by per-block rendering when a
   *  block's `variant` field is undefined. */
  variant?: LowerThirdVariant;
}

export const OnScreenTextLayer: React.FC<OnScreenTextLayerProps> = ({
  shot,
  brand,
  durationInFrames,
  suppressLowerThird,
  variant = 'default',
}) => {
  if (suppressLowerThird) return null;

  const blocks = shot.onScreenTextBlocks;
  if (blocks && blocks.length > 0) {
    return (
      <>
        {blocks.map((block) => (
          <PositionedTextBlock
            key={block.id}
            block={block}
            brand={brand}
            totalFrames={durationInFrames}
            fallbackVariant={variant}
          />
        ))}
      </>
    );
  }

  // Legacy fallback: single LowerThird from shot.onScreenText.
  if (!shot.onScreenText) return null;
  return (
    <LowerThird
      text={shot.onScreenText}
      brand={brand}
      totalFrames={durationInFrames}
      delay={12}
      exitBeforeEnd={15}
      variant={variant}
    />
  );
};

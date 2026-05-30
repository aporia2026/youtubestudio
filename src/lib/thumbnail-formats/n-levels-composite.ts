/**
 * N Levels Explained — server-side composite step.
 *
 * Thin wrapper around the shared overlay pipeline. The N Levels image
 * model returns a single rasterized image; this module applies post-
 * process effects and the overlay title bar on top, mirroring the role
 * `applyCellUploads` plays in `topic-card-grid-composite.ts`.
 *
 * Why this module exists separately from `shared-overlay-pipeline.ts`:
 * the route call site stays symmetric with Topic Card Grid (`apply<X>`
 * pattern), and any format-specific composite logic (e.g. per-slice
 * uploads in the future) has a natural home here without polluting the
 * shared module.
 *
 * Pure-ish: uses `sharp` via the shared pipeline. No React, no Next.js,
 * no network.
 */

import type { NLevelsLayout } from './n-levels';
import {
  applySharedOverlays,
  type PostProcessConfig,
  type TitleBarConfig,
} from './shared-overlay-pipeline';

export interface ApplyNLevelsOverlaysInput {
  /** AI-generated image as bytes. Any Sharp-supported format works; output
   *  is always PNG. */
  baseImage: Buffer;
  layout: NLevelsLayout;
  postProcess?: PostProcessConfig;
  titleBar?: TitleBarConfig;
}

/**
 * Apply post-process effects + overlay title bar to an N Levels base
 * image. Returns the final PNG buffer ready to upload to R2.
 *
 * When neither `postProcess` nor `titleBar` is provided the function
 * re-encodes the base image as PNG (single decode + encode) and returns
 * it. Callers that know they have no overlays may want to skip this
 * function entirely to save the re-encode, but invoking it with empty
 * config is also safe.
 */
export async function applyNLevelsOverlays(
  input: ApplyNLevelsOverlaysInput,
): Promise<Buffer> {
  return await applySharedOverlays({
    baseImage: input.baseImage,
    canvas: { width: input.layout.width, height: input.layout.height },
    postProcess: input.postProcess,
    titleBar: input.titleBar,
  });
}

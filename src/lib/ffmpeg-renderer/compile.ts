/**
 * Scene compiler — `VideoShot` → `SceneRecipe`.
 *
 * Pure TypeScript. No disk, no ffmpeg, no network. Translates the
 * existing shot model (the same one Remotion's composition consumes
 * via `productionDocToVideoConfig`) into the intermediate
 * representation the ffmpeg executor needs.
 *
 * Phase 1 scope: still + Ken Burns only. Video clips, overlays,
 * fades, captions, section title stripes — all later phases.
 *
 * The compiler is the choke point where every per-shot decision gets
 * made before any side effect happens. Test by passing recipes and
 * asserting on the SceneRecipe; no need to mock ffmpeg.
 */

import type { VideoShot } from '@/remotion/types';
import { recipeForDirection } from './kenburns';
import type { KenBurnsRecipe, SceneCanvas, SceneRecipe } from './types';

// Ken Burns is OFF by default — `shot.kenBurnsDirection` left undefined
// renders a static still. The legacy "cycle directions by shot index"
// default was removed; motion is now opt-in per-row.

export interface CompileSceneArgs {
  shot: VideoShot;
  /** Zero-based shot index — surfaced on the resulting SceneRecipe. */
  shotIndex: number;
  /** Output canvas. Caller passes the doc's canvas once. */
  canvas: SceneCanvas;
  /** Local file path to the downloaded still image. Resolved by the
   *  caller (the orchestrator downloads remote URLs to /tmp before
   *  invoking the executor). */
  imagePath: string;
  /** Background color when the still doesn't fill the canvas. Hex
   *  `#RRGGBB`. Falls back to doc-level pillarboxColorDefault upstream;
   *  this function just takes the resolved value. */
  backgroundColor: string;
}

/**
 * Build a SceneRecipe for a single still-image scene.
 *
 * Motion is opt-in: only the per-row `shot.kenBurnsDirection` triggers
 * a Ken Burns recipe. When undefined (the default for production-doc
 * rows), the scene renders as a static still — matches BRollScene's
 * preview behaviour.
 *
 * `floatImage === false` is also honoured as an explicit "no motion"
 * knob, preserved for back-compat with shots that set it directly.
 */
export function compileStillScene(args: CompileSceneArgs): SceneRecipe {
  const { shot, shotIndex, canvas, imagePath, backgroundColor } = args;

  let kenBurns: KenBurnsRecipe;
  if (shot.floatImage === false || !shot.kenBurnsDirection) {
    kenBurns = { kind: 'none' };
  } else {
    kenBurns = recipeForDirection(shot.kenBurnsDirection);
  }

  return {
    index: shotIndex,
    canvas,
    durationMs: shot.durationMs,
    inputs: { imagePath },
    kenBurns,
    backgroundColor,
  };
}

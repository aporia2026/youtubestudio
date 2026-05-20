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

const KB_DIRECTIONS = [
  'zoom-in',
  'pan-left',
  'pan-right',
  'zoom-out',
  'pan-up',
  'pan-down',
] as const;

export interface CompileSceneArgs {
  shot: VideoShot;
  /** Zero-based shot index. Used both as the SceneRecipe.index and as
   *  the fallback Ken Burns direction seed (so consecutive shots vary
   *  motion without configuration). */
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
 * Build a SceneRecipe for a single still-image scene with Ken Burns.
 *
 * Direction resolution order:
 *   1. `shot.kenBurnsDirection` (per-row override)
 *   2. Cycle through KB_DIRECTIONS by `shotIndex` to avoid repetition
 *      — matches today's BRollScene behaviour.
 *
 * If `floatImage === false` is explicitly set on the shot, falls back
 * to `{ kind: 'none' }` (static still). Today's editor doesn't surface
 * this directly, but the field exists on VideoShot for future use.
 */
export function compileStillScene(args: CompileSceneArgs): SceneRecipe {
  const { shot, shotIndex, canvas, imagePath, backgroundColor } = args;

  let kenBurns: KenBurnsRecipe;
  if (shot.floatImage === false) {
    kenBurns = { kind: 'none' };
  } else {
    const direction =
      shot.kenBurnsDirection ?? KB_DIRECTIONS[shotIndex % KB_DIRECTIONS.length];
    kenBurns = recipeForDirection(direction);
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

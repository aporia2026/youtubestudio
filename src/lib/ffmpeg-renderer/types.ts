/**
 * Type-level vocabulary for the FFmpeg-native renderer.
 *
 * The renderer's job: take a `VideoConfig` (the same shape today's
 * Remotion pipeline consumes) and turn each `VideoShot` into a
 * standalone scene MP4. Then concatenate the scenes, then mux the
 * master audio. Each step is independently testable.
 *
 * `SceneRecipe` is the intermediate representation between the scene
 * compiler (pure TypeScript) and the scene executor (spawns ffmpeg).
 * Compiler is testable without touching disk; executor is testable
 * with smoke tests that produce real MP4 files.
 *
 * Phase 1 of `_plans/2026-05-20-ffmpeg-native-renderer.md`.
 */

/** Output frame dimensions + frame rate. Always 1920x1080@30 in v1. */
export interface SceneCanvas {
  width: number;
  height: number;
  fps: number;
}

/**
 * Ken Burns motion plan. Pure data — the executor translates this
 * into the actual ffmpeg `zoompan` filter expression.
 *
 * The motion is a constant-velocity transition from `start` framing
 * to `end` framing over the full scene duration. Each framing is a
 * normalized window into the source image: `zoom` is the scale
 * factor (1.0 = original size, 1.15 = 15% closer), `cx`/`cy` are the
 * center of the visible window in [0, 1] image-relative coords.
 *
 * `kind: 'none'` means the still renders motionless at zoom 1 — used
 * when the row explicitly asks for no Ken Burns, or when a video
 * clip will be played instead.
 */
export type KenBurnsRecipe =
  | { kind: 'none' }
  | {
      kind: 'pan-zoom';
      startZoom: number;
      endZoom: number;
      startCx: number;
      startCy: number;
      endCx: number;
      endCy: number;
    };

/**
 * The inputs a scene needs. v1 only supports the b-roll-with-still
 * scene type. Later phases add video clips, overlays, etc.
 */
export interface SceneInputs {
  /**
   * Local file path to the still image. The executor downloads
   * remote URLs to a temp file before invoking ffmpeg — ffmpeg's
   * direct-URL support varies across protocols and we want every
   * input to be a stable local path so the input list is uniform
   * across scene types.
   */
  imagePath: string;
}

/**
 * One scene to render. Produced by the compiler, consumed by the
 * executor.
 */
export interface SceneRecipe {
  /** Zero-based scene index within the doc. Used to name the
   *  intermediate MP4 file. */
  index: number;
  /** Output canvas. Same for every scene in a doc. */
  canvas: SceneCanvas;
  /** Scene duration in milliseconds. The executor converts to frames
   *  using `canvas.fps`. */
  durationMs: number;
  /** Source assets. v1: still image only. Later phases extend this
   *  with `videoPath` for clips. */
  inputs: SceneInputs;
  /** Motion plan. v1: Ken Burns only. */
  kenBurns: KenBurnsRecipe;
  /** Background color used to fill any letterbox/pillarbox area
   *  produced by the scene's aspect ratio not matching the canvas.
   *  Hex `#RRGGBB`. */
  backgroundColor: string;
}

/** Result of executing one scene. Both fields are populated on
 *  success; an error throws instead of returning a partial result. */
export interface SceneExecutionResult {
  /** Absolute path to the scene MP4. The caller is responsible for
   *  deleting it once concatenated; the executor never auto-cleans. */
  outputPath: string;
  /** File size in bytes. Surfaced in the executor's log so a
   *  zero-byte output (silent ffmpeg failure) is immediately
   *  obvious. */
  fileSize: number;
  /** Wall-clock duration of the ffmpeg invocation, in ms. Used by
   *  the assembler's progress estimation. */
  elapsedMs: number;
}

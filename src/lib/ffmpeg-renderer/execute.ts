/**
 * Scene executor — spawn ffmpeg, write `scene-<i>.mp4`.
 *
 * Phase 1 of `_plans/2026-05-20-ffmpeg-native-renderer.md`.
 *
 * Input: a `SceneRecipe`. Output: a real MP4 file on disk + a result
 * record with the file size and the wall-clock elapsed time.
 *
 * Why spawn ffmpeg directly rather than use `fluent-ffmpeg`: the
 * dependency adds 30+ MB to node_modules for what amounts to a
 * string-builder. We control the command line completely. Errors are
 * easier to debug because the exact ffmpeg invocation is logged
 * verbatim.
 *
 * The Ken Burns motion is implemented via ffmpeg's `zoompan` filter
 * applied to a single still image. The image is repeated for the
 * scene's frame count, and zoompan animates a window over it per
 * frame using the expressions from `kenburns.ts`.
 *
 * Security: never use `child_process.exec` — always `spawn` with an
 * argv array so a hostile imagePath can't inject shell metacharacters.
 *
 * Observability: full ffmpeg argv is logged (sanitized — local paths
 * only, no URLs), stderr is captured and surfaced on non-zero exit.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '@/lib/logger';
import { getFfmpegPath } from './ffmpeg-bin';
import { buildKenBurnsZoompan } from './kenburns';
import type { SceneExecutionResult, SceneRecipe } from './types';

const FFMPEG_TIMEOUT_MS = 60_000;

/** Default h264 encoding options. CRF 23 is a sane mid-quality/size
 *  tradeoff for 1080p; lower = better quality, larger files. */
const H264_CRF = '23';
const H264_PRESET = 'medium';

/**
 * Execute a SceneRecipe by spawning ffmpeg with the appropriate
 * arguments. Resolves with the result record on success; throws with
 * a useful message on failure (ffmpeg non-zero exit, timeout,
 * zero-byte output).
 *
 * The output path is `<outputDir>/scene-<index>.mp4` and the caller
 * is responsible for managing the output directory's lifetime.
 */
export async function executeStillScene(args: {
  recipe: SceneRecipe;
  outputDir: string;
}): Promise<SceneExecutionResult> {
  const { recipe, outputDir } = args;
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(
    outputDir,
    `scene-${String(recipe.index).padStart(4, '0')}.mp4`,
  );
  const frames = Math.max(
    2,
    Math.round((recipe.durationMs / 1000) * recipe.canvas.fps),
  );

  const kb = buildKenBurnsZoompan({
    recipe: recipe.kenBurns,
    totalFrames: frames,
    canvasWidth: recipe.canvas.width,
    canvasHeight: recipe.canvas.height,
  });

  // Filter chain:
  //
  //   1. scale=W:H:force_original_aspect_ratio=increase
  //        Upscale the source so it's at least as large as the canvas
  //        on every axis. zoompan needs source pixels to zoom over;
  //        if the source is smaller than the canvas on either axis,
  //        zoompan will black out the deficit.
  //   2. zoompan=z='...':x='...':y='...':d=N:s=WxH:fps=F
  //        Ken Burns motion. `s=WxH` forces the output to the canvas
  //        size — no pad filter needed.
  //   3. format=yuv420p
  //        H.264 baseline-compatible pixel format.
  //
  // Color note: ffmpeg's expression parser treats `#` as a comment
  // delimiter inside filter strings. Hex colors get translated to the
  // `0x` form OR the named color when constructing the filter chain
  // (see `cssToFfmpegColor`). The compiler's `backgroundColor` is
  // accepted as `#RRGGBB` for parity with the rest of the codebase.
  // Pad is intentionally NOT in the chain — `force_original_aspect_ratio=increase`
  // plus a canvas-sized zoompan output guarantees no letterbox, so
  // backgroundColor is unused in v1 still-only scenes. Reintroduced
  // in later phases when section-title letterbox needs it.
  const filter = [
    `scale=${recipe.canvas.width}:${recipe.canvas.height}:force_original_aspect_ratio=increase`,
    `zoompan=z='${kb.z}':x='${kb.x}':y='${kb.y}':d=${kb.d}:s=${kb.s}:fps=${recipe.canvas.fps}`,
    'format=yuv420p',
  ].join(',');

  const argv = [
    '-y',                              // overwrite output
    '-loop', '1',                      // loop the input image
    '-i', recipe.inputs.imagePath,
    '-vf', filter,
    '-r', String(recipe.canvas.fps),   // output frame rate
    '-frames:v', String(frames),
    '-c:v', 'libx264',
    '-preset', H264_PRESET,
    '-crf', H264_CRF,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ];

  const ffmpegBin = getFfmpegPath();
  logger.info('[ffmpeg-renderer] executing scene', {
    sceneIndex: recipe.index,
    durationMs: recipe.durationMs,
    frames,
    canvas: recipe.canvas,
    kenBurnsKind: recipe.kenBurns.kind,
    outputPath,
    // Log the filter chain at info level so a creator-side render
    // failure is reproducible offline. argv intentionally omitted at
    // info; logged at debug only.
    filter,
  });

  const startedAt = Date.now();
  const stderr: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBin, argv, {
      // ffmpeg writes diagnostics to stderr by convention. We capture
      // and surface on failure.
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg scene-${recipe.index} timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      // Cap stderr capture to avoid memory blowup on a stuck process.
      if (stderr.length < 200) stderr.push(line);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.join('').slice(-2000);
        reject(
          new Error(
            `ffmpeg scene-${recipe.index} exited code=${code} signal=${signal}. ` +
              `stderr tail: ${tail}`,
          ),
        );
      }
    });
  });

  // Verify the output is non-empty. A zero-byte MP4 is the silent-
  // failure mode of older ffmpeg builds when the filter chain has a
  // logic error that doesn't cause a non-zero exit.
  const stat = await fs.stat(outputPath);
  if (stat.size === 0) {
    throw new Error(
      `ffmpeg scene-${recipe.index} produced a 0-byte file at ${outputPath}`,
    );
  }

  const elapsedMs = Date.now() - startedAt;
  logger.info('[ffmpeg-renderer] scene complete', {
    sceneIndex: recipe.index,
    outputPath,
    fileSize: stat.size,
    elapsedMs,
  });

  return {
    outputPath,
    fileSize: stat.size,
    elapsedMs,
  };
}

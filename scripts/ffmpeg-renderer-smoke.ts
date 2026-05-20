/**
 * Phase 1 smoke test for the FFmpeg renderer.
 *
 * Renders a single still-image scene with Ken Burns motion to a real
 * MP4 file. No production-doc state needed — uses any image file you
 * point it at.
 *
 * Usage:
 *   npx tsx scripts/ffmpeg-renderer-smoke.ts <imagePath> [durationMs] [direction]
 *
 * Examples:
 *   npx tsx scripts/ffmpeg-renderer-smoke.ts public/test.png
 *   npx tsx scripts/ffmpeg-renderer-smoke.ts public/test.png 5000 zoom-in
 *   npx tsx scripts/ffmpeg-renderer-smoke.ts public/test.png 7000 pan-left
 *
 * Output: out/ffmpeg-renderer-smoke-<timestamp>.mp4
 *
 * Exit criteria for Phase 1 (per
 * `_plans/2026-05-20-ffmpeg-native-renderer.md`):
 *   - 5-second 1920x1080 30fps MP4
 *   - Image visibly animates (zoom or pan)
 *   - File size ~3-6 MB
 *   - Plays in VLC + browser
 */

import path from 'path';
import fs from 'fs/promises';
import { compileStillScene } from '../src/lib/ffmpeg-renderer/compile';
import { executeStillScene } from '../src/lib/ffmpeg-renderer/execute';
import type { VideoShot } from '../src/remotion/types';

const VALID_DIRECTIONS = new Set<VideoShot['kenBurnsDirection']>([
  'zoom-in',
  'zoom-out',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down',
]);

async function main() {
  const imageArg = process.argv[2];
  const durationArg = Number(process.argv[3] ?? 5000);
  const directionArg = process.argv[4] as VideoShot['kenBurnsDirection'] | undefined;

  if (!imageArg) {
    process.stderr.write(
      'Usage: npx tsx scripts/ffmpeg-renderer-smoke.ts <imagePath> [durationMs] [direction]\n' +
      '  durationMs defaults to 5000\n' +
      '  direction defaults to zoom-in (cycles through KB_DIRECTIONS if multiple shots)\n',
    );
    process.exit(1);
  }

  const absoluteImagePath = path.isAbsolute(imageArg)
    ? imageArg
    : path.join(process.cwd(), imageArg);
  try {
    await fs.access(absoluteImagePath);
  } catch {
    process.stderr.write(`Image not found at ${absoluteImagePath}\n`);
    process.exit(1);
  }

  if (!Number.isFinite(durationArg) || durationArg < 1000 || durationArg > 60000) {
    process.stderr.write(`durationMs out of range [1000, 60000]: ${durationArg}\n`);
    process.exit(1);
  }

  if (directionArg && !VALID_DIRECTIONS.has(directionArg)) {
    process.stderr.write(
      `Unknown direction: ${directionArg}. Use one of: ${Array.from(VALID_DIRECTIONS).join(', ')}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`Compiling SceneRecipe…\n`);
  process.stdout.write(`  image:     ${path.relative(process.cwd(), absoluteImagePath)}\n`);
  process.stdout.write(`  duration:  ${durationArg}ms (${(durationArg / 1000).toFixed(1)}s)\n`);
  process.stdout.write(`  direction: ${directionArg ?? 'zoom-in (default)'}\n`);

  const shot: VideoShot = {
    startMs: 0,
    durationMs: durationArg,
    sceneType: 'b-roll',
    imageUrl: 'file://' + absoluteImagePath, // not used by Phase 1 — imagePath is on the recipe
    kenBurnsDirection: directionArg,
    floatImage: true,
  };

  const recipe = compileStillScene({
    shot,
    shotIndex: 0,
    canvas: { width: 1920, height: 1080, fps: 30 },
    imagePath: absoluteImagePath,
    backgroundColor: '#000000',
  });

  process.stdout.write(`\nSceneRecipe:\n${JSON.stringify(recipe, null, 2)}\n`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'out', `ffmpeg-renderer-smoke-${timestamp}`);
  process.stdout.write(`\nExecuting scene → ${path.relative(process.cwd(), outDir)}/\n`);

  const result = await executeStillScene({ recipe, outputDir: outDir });

  const mb = (result.fileSize / 1024 / 1024).toFixed(2);
  process.stdout.write(`\nDone.\n`);
  process.stdout.write(`  Output:    ${path.relative(process.cwd(), result.outputPath)}\n`);
  process.stdout.write(`  Size:      ${mb} MB\n`);
  process.stdout.write(`  Elapsed:   ${result.elapsedMs}ms\n`);
  process.stdout.write(`\nOpen the MP4 in VLC or a browser to verify:\n`);
  process.stdout.write(`  - Is it ${(durationArg / 1000).toFixed(1)} seconds long?\n`);
  process.stdout.write(`  - Does the image visibly move (${directionArg ?? 'zoom-in'})?\n`);
  process.stdout.write(`  - Is the resolution 1920x1080?\n`);
  process.stdout.write(`  - Is the frame rate 30fps?\n`);
  process.stdout.write(`\nffprobe ${path.relative(process.cwd(), result.outputPath)}  # to inspect\n`);
}

main().catch((err) => {
  process.stderr.write(`Smoke test failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`Stack:\n${err.stack}\n`);
  }
  process.exit(1);
});

/**
 * ffmpeg subprocess wrapper for channel-clone frame extraction.
 *
 * One job per pipeline: take a downloaded video file, sample frames
 * at a configurable interval (default 10s) at 480px wide, write
 * them as JPEGs into the per-job temp directory. The frames feed
 * the analyze stage's visual style profile (the LLM is multimodal
 * and reads the JPEGs directly).
 *
 * Like yt-dlp, ffmpeg can only run in dev mode locally. See
 * `assertIntakeAvailable()` in `./yt-dlp.ts` for the production
 * guard rationale.
 *
 * Security:
 *   - Spawned with argv array (`shell: false`) so a hostile
 *     videoPath can't inject shell metacharacters.
 *   - The output filename pattern uses ffmpeg's own `%03d` token,
 *     never a user-supplied string interpolation.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import { logger } from '@/lib/logger';

/** Hard timeout for the ffmpeg process. 480p frame extraction is
 *  CPU-cheap; 60s covers an hour-long input on a laptop. */
const FFMPEG_TIMEOUT_MS = 60_000;

export interface FrameExtractionOptions {
  /** Sample interval in seconds. Default 10. */
  intervalSec?: number;
  /** Target frame width in pixels. Aspect ratio preserved by `-2`
   *  height (= "even integer derived from input AR"). Default 480. */
  widthPx?: number;
  /** JPEG quality 2 (best) through 31 (worst). Default 5. */
  jpegQuality?: number;
}

export interface FrameExtractionResult {
  /** Absolute paths to the extracted frames in playback order. */
  framePaths: string[];
  /** ms wall-clock the ffmpeg invocation took. Surfaced for
   *  observability — long extractions are worth flagging. */
  durationMs: number;
}

/** Resolve the ffmpeg binary path. Prefers `process.env.FFMPEG_PATH`
 *  for explicit override; falls back to `ffmpeg` on PATH. The
 *  WinGet install on Windows places ffmpeg under
 *  `C:\Users\…\WinGet\Packages\Gyan.FFmpeg…` which is normally
 *  added to PATH by WinGet; mismatches surface here as a clean
 *  "ffmpeg not found" error from the spawn() ENOENT. */
function resolveFfmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/** Spawn ffmpeg to extract sampled frames from a video file. */
export async function extractFrames(
  videoLocalPath: string,
  outDir: string,
  options: FrameExtractionOptions = {},
): Promise<FrameExtractionResult> {
  const intervalSec = options.intervalSec ?? 10;
  const widthPx = options.widthPx ?? 480;
  const jpegQuality = options.jpegQuality ?? 5;

  if (!Number.isInteger(intervalSec) || intervalSec < 1 || intervalSec > 600) {
    throw new Error(`intervalSec must be an integer in [1, 600], got ${intervalSec}`);
  }
  if (!Number.isInteger(widthPx) || widthPx < 64 || widthPx > 1920) {
    throw new Error(`widthPx must be an integer in [64, 1920], got ${widthPx}`);
  }
  if (!Number.isInteger(jpegQuality) || jpegQuality < 2 || jpegQuality > 31) {
    throw new Error(`jpegQuality must be an integer in [2, 31], got ${jpegQuality}`);
  }

  await fs.mkdir(outDir, { recursive: true });

  const filter = `fps=1/${intervalSec},scale=${widthPx}:-2`;
  const outputPattern = `${outDir}/f%03d.jpg`;
  const ffmpeg = resolveFfmpegPath();
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', videoLocalPath,
    '-vf', filter,
    '-q:v', String(jpegQuality),
    outputPattern,
  ];

  logger.info('[channel-clone ffmpeg] extract start', {
    videoLocalPath,
    outDir,
    intervalSec,
    widthPx,
    jpegQuality,
  });

  const startedAt = Date.now();
  await runFfmpeg(ffmpeg, args);
  const durationMs = Date.now() - startedAt;

  // List the produced frames in lexicographic order (== playback order
  // given our `%03d` pattern).
  const entries = await fs.readdir(outDir);
  const framePaths = entries
    .filter((name) => /^f\d{3}\.jpg$/.test(name))
    .sort()
    .map((name) => `${outDir}/${name}`);

  logger.info('[channel-clone ffmpeg] extract done', {
    videoLocalPath,
    frameCount: framePaths.length,
    durationMs,
  });

  return { framePaths, durationMs };
}

function runFfmpeg(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: FFMPEG_TIMEOUT_MS,
      shell: false,
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    proc.once('error', (err) => reject(err));
    proc.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500).trim()}`));
    });
  });
}

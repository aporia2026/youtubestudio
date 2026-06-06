/**
 * ffmpeg wrapper for channel-clone frame extraction — runs inside the
 * Vercel Sandbox alongside yt-dlp. See `sandbox-runtime.ts` for the
 * sandbox lifecycle and `yt-dlp.ts` for the sibling.
 *
 * Same job per pipeline as before: sample frames at a configurable
 * interval (default 10s) at 480 px wide, write them as JPEGs. The
 * frames feed the analyze stage's visual style profile (the LLM is
 * multimodal and reads the representative middle frame).
 *
 * Security:
 *   - Spawned via argv array — no shell parsing of `videoSandboxPath`.
 *   - The output filename pattern uses ffmpeg's own `%03d` token, not
 *     a user-supplied string interpolation.
 */

import type { Sandbox } from '@vercel/sandbox';
import { logger } from '@/lib/logger';
import { runInSandbox } from './sandbox-runtime';
import type { JobLogger } from './job-logger';

/** Hard timeout for the ffmpeg process. 480p frame extraction is
 *  CPU-cheap; 60 s covers a long input on a single sandbox vCPU. */
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
  /** Sandbox-relative paths to the extracted frames in playback
   *  order. Caller reads back via sandbox.readFileToBuffer. */
  frameSandboxPaths: string[];
  /** ms wall-clock the ffmpeg invocation took — surfaced for
   *  observability; long extractions are worth flagging. */
  durationMs: number;
}

/** Run ffmpeg in the sandbox to extract sampled frames from a
 *  sandbox-resident video. */
export async function extractFrames(
  sandbox: Sandbox,
  ffmpegPath: string,
  videoSandboxPath: string,
  outDir: string,
  options: FrameExtractionOptions = {},
  log?: JobLogger,
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

  // Create the output directory inside the sandbox. mkDir is
  // idempotent — calling on an existing path is a no-op.
  await sandbox.mkDir(outDir);

  const filter = `fps=1/${intervalSec},scale=${widthPx}:-2`;
  const outputPattern = `${outDir}/f%03d.jpg`;
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', videoSandboxPath,
    '-vf', filter,
    '-q:v', String(jpegQuality),
    outputPattern,
  ];

  log?.info('ffmpeg', 'extract frames start', { intervalSec, widthPx });
  logger.info('[channel-clone ffmpeg] extract start', {
    videoSandboxPath,
    outDir,
    intervalSec,
    widthPx,
    jpegQuality,
  });

  const startedAt = Date.now();
  const { stderr, exitCode } = await runInSandbox(sandbox, {
    cmd: ffmpegPath,
    args,
    timeoutMs: FFMPEG_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited with code ${exitCode}: ${stderr.slice(-2000).trim()}`);
  }

  // Probe the output directory to discover what ffmpeg actually
  // produced. We can't ls the sandbox filesystem directly via the
  // SDK, so we run `ls` as a command and parse its stdout. The
  // `-1` flag prints one name per line.
  const lsResult = await runInSandbox(sandbox, {
    cmd: 'ls',
    args: ['-1', outDir],
    timeoutMs: 5_000,
  });
  if (lsResult.exitCode !== 0) {
    throw new Error(`could not list frame outputs: ${lsResult.stderr.slice(-2000).trim()}`);
  }
  const frameSandboxPaths = lsResult.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((name) => /^f\d{3}\.jpg$/.test(name))
    .sort()
    .map((name) => `${outDir}/${name}`);

  log?.info('ffmpeg', 'extract frames done', { frameCount: frameSandboxPaths.length, durationMs });
  logger.info('[channel-clone ffmpeg] extract done', {
    videoSandboxPath,
    frameCount: frameSandboxPaths.length,
    durationMs,
  });

  return { frameSandboxPaths, durationMs };
}

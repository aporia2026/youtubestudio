/**
 * Mode B v1-lite — clip an existing MP4 into a vertical Short via
 * dumb center-crop. Phase 15.7.
 *
 * Honest scope (per the council's defer-Mode-B verdict + the user's
 * "ship the v1" directive):
 *
 *   - User provides a source video URL (already-uploaded MP4) + a
 *     start/end second range.
 *   - We trim with `-ss` / `-to`, center-crop 16:9 → 9:16 via the
 *     `crop` filter (no face tracking, no smart subject detection),
 *     re-encode to MP4 with the system ffmpeg.
 *   - Output uploaded to the same R2 review bucket the long-form
 *     renderer writes to.
 *   - A new `shorts` row is created with `medium='short_clip'`,
 *     `kind='channel_clip_recommendation'`, `rendered_video_url`
 *     populated. The row plugs into the existing inbox / publishing
 *     paths.
 *
 * What this DOESN'T do (Phase 15.7.B follow-up):
 *   - Smart-reframe (face tracking, autoflip-equivalent)
 *   - Whisper auto-caption burn-in
 *   - Background-job orchestration for long sources
 *   - Browser file upload (caller provides a URL — the upload UI is
 *     a separate piece that can land later)
 *
 * Vercel function 300s budget: a 60s clip from a 16:9 1080p source
 * typically runs in <30s. Long sources (>30 min) risk timing out. The
 * caller surfaces this as a soft warning in the UI.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getFfmpegPath } from './ffmpeg-renderer/ffmpeg-bin';
import { logger } from './logger';

const SHORT_TARGET_WIDTH = 1080;
const SHORT_TARGET_HEIGHT = 1920;
/** Dumb center-crop math for a 16:9 → 9:16 letterbox.
 *
 *  We take an `in_h * 9 / 16`-wide column centered horizontally. For a
 *  1920×1080 source, that's a 607.5-pixel-wide strip from the middle —
 *  re-encoded back up to 1080×1920 with `scale`. Loses ~52% of the
 *  horizontal frame; subjects on the sides get chopped. This is the
 *  exact tradeoff the council warned about. We let it ship because
 *  the user accepted the "dumb crop" tradeoff for v1-lite.
 */
export function buildCenterCrop916FilterArg(): string {
  // Two-step filtergraph: first crop to 9:16 aspect, then scale to
  // canonical 1080×1920. The `crop` filter accepts expressions for
  // dimensions so any input resolution works without prior ffprobe.
  return [
    `crop=floor(in_h*9/16/2)*2:in_h:floor((in_w-in_h*9/16)/2):0`,
    `scale=${SHORT_TARGET_WIDTH}:${SHORT_TARGET_HEIGHT}`,
  ].join(',');
}

/** Pure helper — returns the ffmpeg arg array for clip + crop. Exported
 *  for unit tests so the most error-prone piece (ffmpeg flag order) is
 *  asserted without spawning a process. */
export function buildClipFfmpegArgs(args: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  outputPath: string;
}): string[] {
  const duration = Math.max(0.5, args.endSec - args.startSec);
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    // Place -ss BEFORE -i for fast seek. Less accurate at the
    // I-frame boundary but cuts the read budget dramatically; for v1
    // we accept the +/- 1 frame imprecision.
    '-ss',
    args.startSec.toFixed(3),
    '-t',
    duration.toFixed(3),
    '-i',
    args.sourceUrl,
    '-vf',
    buildCenterCrop916FilterArg(),
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-y',
    args.outputPath,
  ];
}

export interface ClipFromMp4Args {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  /** Hard timeout in ms. Defaults to 270_000 (Vercel 300s budget minus a 30s
   *  buffer for upload + DB write). */
  timeoutMs?: number;
}

export interface ClipFromMp4Result {
  outputPath: string;
  byteLength: number;
  durationSec: number;
  ffmpegStderrPreview: string;
}

export const CLIP_DEFAULT_TIMEOUT_MS = 270_000;
export const CLIP_MIN_DURATION_SEC = 3;
export const CLIP_MAX_DURATION_SEC = 90;

/** Validate clip range bounds. Returns a string error or null. */
export function validateClipRange(startSec: unknown, endSec: unknown): string | null {
  if (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0) {
    return 'start_seconds must be a non-negative number';
  }
  if (typeof endSec !== 'number' || !Number.isFinite(endSec)) {
    return 'end_seconds must be a number';
  }
  if (endSec <= startSec) {
    return 'end_seconds must be greater than start_seconds';
  }
  const dur = endSec - startSec;
  if (dur < CLIP_MIN_DURATION_SEC) {
    return `clip duration must be at least ${CLIP_MIN_DURATION_SEC}s`;
  }
  if (dur > CLIP_MAX_DURATION_SEC) {
    return `clip duration cannot exceed ${CLIP_MAX_DURATION_SEC}s (YouTube Shorts cap is 180s, we cap tighter for the dumb-crop pipeline)`;
  }
  return null;
}

/** Run ffmpeg via the bundled binary to produce a 1080×1920 MP4 at the
 *  caller's outputPath. Used by the API route after generating a temp
 *  path; caller is responsible for reading + uploading + deleting. */
export async function runCenterCrop916(args: ClipFromMp4Args & { outputPath: string }): Promise<ClipFromMp4Result> {
  const t0 = Date.now();
  const ffmpegPath = getFfmpegPath();
  const ffArgs = buildClipFfmpegArgs(args);
  const timeoutMs = args.timeoutMs ?? CLIP_DEFAULT_TIMEOUT_MS;

  logger.info('[shorts mode-b clip] start', {
    sourceUrlHost: tryGetHost(args.sourceUrl),
    startSec: args.startSec,
    endSec: args.endSec,
    durationSec: args.endSec - args.startSec,
  });

  return await new Promise<ClipFromMp4Result>((resolve, reject) => {
    const child = spawn(ffmpegPath, ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* best effort */
      }
      reject(new Error(`ffmpeg clip timed out after ${timeoutMs}ms — try a shorter source video or a shorter clip range.`));
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrPreview = Buffer.concat(stderrChunks).toString('utf8').slice(0, 800);
      if (code !== 0) {
        logger.warn('[shorts mode-b clip] ffmpeg non-zero exit', {
          code,
          stderrPreview,
        });
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrPreview.slice(0, 400)}`));
        return;
      }
      try {
        const fs = await import('node:fs/promises');
        const stat = await fs.stat(args.outputPath);
        logger.info('[shorts mode-b clip] done', {
          outputPath: args.outputPath,
          byteLength: stat.size,
          durationMs: Date.now() - t0,
        });
        resolve({
          outputPath: args.outputPath,
          byteLength: stat.size,
          durationSec: args.endSec - args.startSec,
          ffmpegStderrPreview: stderrPreview,
        });
      } catch (err) {
        reject(new Error(`ffmpeg succeeded but output file missing: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}

/** Compose a stable output filename under the workspace prefix. The
 *  caller passes the bucket prefix; we just generate the per-clip
 *  segment with a UUID to avoid collisions between concurrent clips. */
export function buildClipOutputKey(workspaceId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `shorts/mode-b/${workspaceId}/${stamp}_${randomUUID()}.mp4`;
}

function tryGetHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

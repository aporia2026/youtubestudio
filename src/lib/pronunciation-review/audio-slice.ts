/**
 * Audio slicing for the Gemini judge step.
 *
 * Given the full narration audio bytes and a candidate's start/end
 * timestamp, produce a small WAV buffer containing just that segment
 * (with padding) for inline embedding in a Gemini request.
 *
 * Why slice at all? Sending the full 14-min narration to Gemini for
 * every candidate would be cost-prohibitive (~$0.021 per call × 60
 * candidates = $1.26 per take) and slow. Slicing to ~3 second clips
 * brings the per-candidate cost to ~$0.0004.
 *
 * Implementation: spawn ffmpeg via `@ffmpeg-installer/ffmpeg` (the
 * same binary the FFmpeg renderer uses — see
 * `src/lib/ffmpeg-renderer/ffmpeg-bin.ts`). Input is the full audio
 * written to a temp file once per orchestrator run, output is a WAV
 * stream piped back to a Buffer. ffmpeg's `-ss` (start) and `-t`
 * (duration) are accurate enough at second granularity for our
 * purpose; the judge listens for word-shaped chunks, not single
 * phonemes.
 *
 * Lifecycle: caller is responsible for `prepareSliceSource` (write
 * once) and `cleanupSliceSource` (delete the temp file). Slices
 * themselves never touch disk — they stream through stdout into a
 * Buffer.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getFfmpegPath } from '../ffmpeg-renderer/ffmpeg-bin';
import { logger } from '../logger';

/** Padding (seconds) added to each side of the candidate's word range
 *  so the Gemini judge has audio context. 0.3 s captures the syllable
 *  before/after — enough for the judge to confirm word boundaries
 *  without bloating the clip. */
export const SLICE_PADDING_SEC = 0.3;

/** Per-slice ffmpeg timeout. The slice itself is ~3 s of audio so
 *  ffmpeg should finish in well under 5 s even on cold start. A
 *  longer ceiling here is a safety net, not a tuning knob. */
const FFMPEG_TIMEOUT_MS = 15_000;

export interface SliceSource {
  /** Path to the temp file holding the full audio. Caller passes this
   *  to every `sliceAudioToWav` call for this take. */
  inputPath: string;
}

/**
 * Write the full audio Blob to a unique tempfile so subsequent slice
 * calls have a stable path. Returns the source descriptor. Pair with
 * `cleanupSliceSource(source)` once all slices are done — the temp
 * file is ~10–30 MB and we don't want it lingering in /tmp.
 *
 * Filename includes the take id to avoid collisions when two takes
 * are reviewed concurrently in the same function instance (rare but
 * possible under fan-out).
 */
export async function prepareSliceSource(
  audio: Blob,
  takeId: string,
  filenameExt: string,
): Promise<SliceSource> {
  const buf = Buffer.from(await audio.arrayBuffer());
  // Sanitize extension — we trust the caller but defensive-strip
  // path-y characters just in case.
  const safeExt = filenameExt.replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'bin';
  const safeId = takeId.replace(/[^a-z0-9-]/gi, '').slice(0, 64);
  const inputPath = join(tmpdir(), `pr-${safeId}-${Date.now()}.${safeExt}`);
  await fs.writeFile(inputPath, buf);
  logger.info('[pronunciation-review slice] source prepared', {
    inputPath,
    bytes: buf.byteLength,
  });
  return { inputPath };
}

/**
 * Delete the temp source file. Idempotent — a missing file is not an
 * error (the orchestrator's outer catch may invoke this after a crash
 * that already cleaned things up).
 */
export async function cleanupSliceSource(source: SliceSource): Promise<void> {
  try {
    await fs.unlink(source.inputPath);
  } catch (err) {
    // ENOENT is fine; anything else is unexpected but non-fatal.
    if ((err as { code?: string }).code !== 'ENOENT') {
      logger.warn('[pronunciation-review slice] cleanup failed', {
        inputPath: source.inputPath,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export interface SliceArgs {
  source: SliceSource;
  /** Start of the audio window (seconds, relative to source). The
   *  slicer adds `SLICE_PADDING_SEC` of pre-roll. */
  startSec: number;
  /** End of the audio window. The slicer adds `SLICE_PADDING_SEC` of
   *  post-roll. */
  endSec: number;
}

/**
 * Extract a WAV slice covering [startSec - padding, endSec + padding].
 *
 * Output format is 16 kHz mono PCM WAV — Gemini accepts that natively
 * and the lower sample rate keeps the inline base64 size small (~32
 * KB per 3-sec clip vs. ~150 KB at 44.1 kHz stereo). Speech recognition
 * doesn't benefit from higher sample rates so we lose nothing.
 *
 * Throws if ffmpeg fails (non-zero exit, timeout, or spawn error).
 */
export async function sliceAudioToWav(args: SliceArgs): Promise<Buffer> {
  const ffmpegPath = getFfmpegPath();
  const startWithPad = Math.max(0, args.startSec - SLICE_PADDING_SEC);
  const duration = Math.max(0.05, args.endSec - args.startSec + SLICE_PADDING_SEC * 2);

  // ffmpeg args:
  //   -nostdin    : don't try to read controls from stdin
  //   -hide_banner -loglevel error : keep stderr quiet on success
  //   -ss <sec>   : seek to start (placed BEFORE -i = fast seek)
  //   -t <sec>    : duration
  //   -i <file>   : input
  //   -ac 1       : mono
  //   -ar 16000   : 16 kHz
  //   -f wav      : output container
  //   -          : stdout
  const ffArgs = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    startWithPad.toFixed(3),
    '-t',
    duration.toFixed(3),
    '-i',
    args.source.inputPath,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    'wav',
    '-',
  ];

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpegPath, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort
      }
      reject(new Error(`ffmpeg slice timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 280);
        reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
        return;
      }
      const out = Buffer.concat(stdoutChunks);
      if (out.length === 0) {
        reject(new Error('ffmpeg produced empty output'));
        return;
      }
      resolve(out);
    });
  });
}

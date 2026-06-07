/**
 * Audio-sample extraction for the channel-clone voice-profile stage.
 *
 * Runs inside the same Vercel Sandbox microVM as `ffmpeg.ts` so we
 * don't spin up a second sandbox just for audio. The work is:
 *
 *   1. Pick a 30-second window inside the source video, starting at
 *      `startSec`. The caller decides the start (usually 10% of the
 *      video duration to skip intro music).
 *   2. Re-encode that window as mono 16 kHz MP3 (32 kbps). This is
 *      the lowest fidelity that's still useful for ElevenLabs Instant
 *      Voice Cloning AND fits comfortably under multimodal LLM
 *      input-token limits.
 *   3. Probe the produced clip with `silencedetect` so the caller
 *      can decide whether to slide the window forward (the picked
 *      window might be intro music or an outro card with no spoken
 *      narration). Memory `feedback_audio_verification.md`: never
 *      infer audio content from alignment / transcripts alone.
 *
 * Plan 1: _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md
 *
 * Security:
 *   - Spawned via argv array — no shell parsing of caller-supplied
 *     paths.
 *   - Output filename is a fixed sandbox path; the caller controls
 *     `outSandboxPath` and is expected to keep it inside the
 *     per-job working directory.
 */

import type { Sandbox } from '@vercel/sandbox';
import { logger } from '@/lib/logger';
import { runInSandbox } from './sandbox-runtime';
import type { JobLogger } from './job-logger';

/** Hard timeout for the audio-encode + silence-probe ffmpeg calls.
 *  30 s of mono MP3 encoding is sub-second on a sandbox vCPU; this
 *  is a safety net for stalled processes. */
const FFMPEG_AUDIO_TIMEOUT_MS = 60_000;

export interface AudioWindowOptions {
  /** Start offset within the video, in seconds. Integer. */
  startSec: number;
  /** Window duration in seconds. Default 30. ElevenLabs Instant
   *  Voice Cloning accepts as little as 60 s; we err on the smaller
   *  side here so the MP3 stays under 250 KB. */
  durationSec?: number;
  /** Sample rate in Hz. Default 16000 (matches the LLM-side speech
   *  encoders + ElevenLabs' minimum). */
  sampleRateHz?: number;
  /** Bitrate in kbps. Default 32. */
  bitrateKbps?: number;
}

export interface AudioExtractionResult {
  /** Sandbox-relative path the caller can read with
   *  `sandbox.readFileToBuffer`. */
  audioSandboxPath: string;
  /** Encoded MP3 size in bytes, parsed from ffmpeg stderr. 0 when
   *  unparseable — caller should probe `readFileToBuffer().length`
   *  if it cares about the exact value. */
  bytesEncoded: number;
  durationMs: number;
}

export interface SilenceProbeResult {
  /** Total seconds of detected silence in the window. */
  totalSilenceSec: number;
  /** True when >50% of the window is silent — caller treats this as
   *  "try a different window". */
  isLikelyMusicOrSilence: boolean;
}

/** Extract a single audio window from a sandbox-resident video. */
export async function extractAudioWindow(
  sandbox: Sandbox,
  ffmpegPath: string,
  videoSandboxPath: string,
  outSandboxPath: string,
  options: AudioWindowOptions,
  log?: JobLogger,
): Promise<AudioExtractionResult> {
  const startSec = options.startSec;
  const durationSec = options.durationSec ?? 30;
  const sampleRateHz = options.sampleRateHz ?? 16000;
  const bitrateKbps = options.bitrateKbps ?? 32;

  if (!Number.isInteger(startSec) || startSec < 0 || startSec > 60_000) {
    throw new Error(`startSec must be an integer in [0, 60000], got ${startSec}`);
  }
  if (!Number.isInteger(durationSec) || durationSec < 5 || durationSec > 600) {
    throw new Error(`durationSec must be an integer in [5, 600], got ${durationSec}`);
  }
  if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8000 || sampleRateHz > 48000) {
    throw new Error(`sampleRateHz must be an integer in [8000, 48000], got ${sampleRateHz}`);
  }
  if (!Number.isInteger(bitrateKbps) || bitrateKbps < 16 || bitrateKbps > 256) {
    throw new Error(`bitrateKbps must be an integer in [16, 256], got ${bitrateKbps}`);
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', String(startSec),
    '-t', String(durationSec),
    '-i', videoSandboxPath,
    '-vn',
    '-ac', '1',
    '-ar', String(sampleRateHz),
    '-b:a', `${bitrateKbps}k`,
    outSandboxPath,
  ];

  log?.info('voice-extract', 'audio encode start', { startSec, durationSec, sampleRateHz, bitrateKbps });
  logger.info('[channel-clone voice-extract] audio encode start', {
    videoSandboxPath, outSandboxPath, startSec, durationSec,
  });

  const startedAt = Date.now();
  const { stderr, exitCode } = await runInSandbox(sandbox, {
    cmd: ffmpegPath,
    args,
    timeoutMs: FFMPEG_AUDIO_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;
  if (exitCode !== 0) {
    throw new Error(`ffmpeg (audio) exited with code ${exitCode}: ${stderr.slice(-2000).trim()}`);
  }

  // Try to parse the encoded size from ffmpeg's stderr summary.
  // Best-effort — failures fall through to bytesEncoded=0.
  const sizeMatch = /Output #0,.*?size=\s*(\d+)\s*kB/.exec(stderr);
  const bytesEncoded = sizeMatch ? Number(sizeMatch[1]) * 1024 : 0;

  log?.info('voice-extract', 'audio encode done', { durationMs, bytesEncoded });
  logger.info('[channel-clone voice-extract] audio encode done', {
    outSandboxPath, durationMs, bytesEncoded,
  });

  return { audioSandboxPath: outSandboxPath, bytesEncoded, durationMs };
}

/** Run ffmpeg `silencedetect` on the supplied audio file and return
 *  a coarse "is this mostly silence / music?" verdict. Threshold and
 *  min-duration are tuned for spoken narration:
 *
 *  - -30 dB noise floor: anything below this is silence.
 *  - 2 s minimum silence: shorter pauses don't count.
 *
 *  Music-only sections typically have NO silence longer than 2 s, so
 *  this heuristic isn't a perfect classifier — but for the channel-
 *  clone use case (typical YouTube narration) it catches the obvious
 *  "all silent" and "all music" windows. */
export async function probeWindowForSilence(
  sandbox: Sandbox,
  ffmpegPath: string,
  audioSandboxPath: string,
  windowDurationSec: number,
  log?: JobLogger,
): Promise<SilenceProbeResult> {
  const args = [
    '-hide_banner',
    '-i', audioSandboxPath,
    '-af', 'silencedetect=noise=-30dB:d=2',
    '-f', 'null', '-',
  ];

  log?.info('voice-extract', 'silence probe start', { audioSandboxPath });

  const { stderr, exitCode } = await runInSandbox(sandbox, {
    cmd: ffmpegPath,
    args,
    timeoutMs: FFMPEG_AUDIO_TIMEOUT_MS,
  });
  if (exitCode !== 0) {
    throw new Error(`ffmpeg (silence-probe) exited with code ${exitCode}: ${stderr.slice(-2000).trim()}`);
  }

  // silencedetect emits lines like:
  //   [silencedetect @ 0x...] silence_start: 3.2
  //   [silencedetect @ 0x...] silence_end: 7.8 | silence_duration: 4.6
  // We sum the silence_duration values.
  const durations = Array.from(stderr.matchAll(/silence_duration:\s*([\d.]+)/g)).map((m) => Number(m[1]));
  const totalSilenceSec = durations.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
  const isLikelyMusicOrSilence = totalSilenceSec > windowDurationSec * 0.5;

  log?.info('voice-extract', 'silence probe done', {
    audioSandboxPath, totalSilenceSec, windowDurationSec, isLikelyMusicOrSilence,
  });

  return { totalSilenceSec, isLikelyMusicOrSilence };
}

/** Parse the silence_duration values out of a captured stderr blob.
 *  Exposed for unit-testing — `probeWindowForSilence` calls it
 *  internally after invoking ffmpeg. */
export function parseSilenceDurationsFromStderr(stderr: string): number[] {
  return Array.from(stderr.matchAll(/silence_duration:\s*([\d.]+)/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
}

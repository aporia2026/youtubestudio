/**
 * Orchestrator that runs the voice-sample extraction step at the end
 * of the intake stage, just before the sandbox is destroyed.
 *
 *   1. Pick the source video whose cleaned transcript has the most
 *      words (proxy for densest spoken narration).
 *   2. Choose a 30-second starting window at 10% of that video's
 *      duration — avoids intro music + outro cards.
 *   3. ffmpeg-encode that window to mono 16 kHz MP3.
 *   4. Run silencedetect; if the window is >50% silence, slide the
 *      start forward by 30 s and retry. Give up after 3 attempts.
 *   5. Upload the surviving MP3 to R2 under
 *      `channel-clone-voice/<workspaceId>/<jobId>.mp3`.
 *   6. Persist `voiceSample` onto the job state.
 *
 * Best-effort throughout — any failure logs and bails without
 * blocking the rest of intake. See
 * `_plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md`.
 */

import type { Sandbox } from '@vercel/sandbox';
import { logger } from '@/lib/logger';
import { getReviewBucket, uploadToBucket } from '@/lib/r2';
import { extractAudioWindow, probeWindowForSilence } from './extract-audio';
import { mergeChannelCloneJobState } from './job-store';
import type { JobLogger } from './job-logger';
import type { ChannelCloneSampleVideo } from './types';

/** Window length used by both the audio encode and the silence
 *  probe. Centralised so the two stay in sync. */
const WINDOW_DURATION_SEC = 30;

/** Maximum number of windows we'll try before giving up. */
const MAX_WINDOW_ATTEMPTS = 3;

/** Step size when sliding the window forward after a silence hit. */
const WINDOW_SLIDE_STEP_SEC = 30;

export interface VoiceExtractInput {
  jobId: string;
  workspaceId: string;
  sandbox: Sandbox;
  ffmpegPath: string;
  /** Sandbox-resident MP4 paths keyed by sample video id. The intake
   *  runners pass these so the orchestrator can re-encode without
   *  having to re-download the video. */
  videoSandboxPaths: Record<string, string>;
  /** The intake stage's per-video metadata — drives "longest
   *  transcript" picking + duration math. */
  sampleVideos: ChannelCloneSampleVideo[];
  /** Sandbox work directory the encoder can write into. */
  sandboxJobDir: string;
}

export interface VoiceExtractResult {
  r2Key: string;
  sourceVideoId: string;
  startSec: number;
  durationSec: number;
  bytes: number;
}

/** Run the full pick-encode-probe-upload-persist flow. Returns the
 *  `voiceSample` payload on success; returns null on any failure so
 *  the caller can fall through to a "voice profile unavailable"
 *  empty state without aborting intake. */
export async function runVoiceExtractDuringIntake(
  opts: VoiceExtractInput,
  log: JobLogger,
): Promise<VoiceExtractResult | null> {
  const { jobId, workspaceId, sandbox, ffmpegPath, videoSandboxPaths, sampleVideos, sandboxJobDir } = opts;

  // 1. Pick the densest-narration source video. Falls back to the
  //    first video when none have transcripts (e.g. URL intake on a
  //    channel whose captions all failed).
  const chosen = pickDensestNarrationVideo(sampleVideos);
  if (!chosen) {
    log.warn('voice-extract', 'no sample videos available — skipping');
    return null;
  }
  const videoPath = videoSandboxPaths[chosen.videoId];
  if (!videoPath) {
    log.warn('voice-extract', 'chosen video has no sandbox path — skipping', {
      videoId: chosen.videoId,
    });
    return null;
  }
  log.info('voice-extract', 'chosen source video', {
    videoId: chosen.videoId,
    title: chosen.title,
    durationSec: chosen.durationSec,
    transcriptWords: chosen.transcript?.wordCount ?? 0,
  });

  // 2-4. Loop over candidate windows. Start at 10% of duration; on
  //      silence-detected slide forward by 30 s.
  const initialStartSec = Math.max(0, Math.floor(chosen.durationSec * 0.1));
  let attempt = 0;
  let acceptedStartSec = -1;
  let acceptedSandboxPath = '';
  let acceptedBytes = 0;

  while (attempt < MAX_WINDOW_ATTEMPTS) {
    const startSec = initialStartSec + attempt * WINDOW_SLIDE_STEP_SEC;
    // Don't run off the end of the video.
    if (startSec + WINDOW_DURATION_SEC > chosen.durationSec) {
      log.warn('voice-extract', 'no further candidate windows fit inside video', {
        startSec, videoDurationSec: chosen.durationSec,
      });
      break;
    }
    const audioPath = `${sandboxJobDir}/voice-attempt-${attempt}.mp3`;
    try {
      const encoded = await extractAudioWindow(
        sandbox, ffmpegPath, videoPath, audioPath,
        { startSec, durationSec: WINDOW_DURATION_SEC },
        log,
      );
      const silence = await probeWindowForSilence(
        sandbox, ffmpegPath, encoded.audioSandboxPath, WINDOW_DURATION_SEC, log,
      );
      if (silence.isLikelyMusicOrSilence) {
        log.info('voice-extract', 'window-shifted', {
          attempt, startSec, totalSilenceSec: silence.totalSilenceSec,
        });
        attempt += 1;
        continue;
      }
      acceptedStartSec = startSec;
      acceptedSandboxPath = encoded.audioSandboxPath;
      acceptedBytes = encoded.bytesEncoded;
      break;
    } catch (err) {
      log.warn('voice-extract', 'encode-or-probe failed; trying next window', {
        attempt, error: errorMessage(err),
      });
      attempt += 1;
    }
  }

  if (acceptedStartSec < 0) {
    log.error('voice-extract', 'no usable window found in chosen video — giving up');
    return null;
  }

  // 5. Upload to R2.
  let buf: Buffer | null = null;
  try {
    buf = await sandbox.readFileToBuffer({ path: acceptedSandboxPath });
  } catch (err) {
    log.error('voice-extract', 'failed reading encoded MP3 back from sandbox', {
      acceptedSandboxPath, error: errorMessage(err),
    });
    return null;
  }
  if (!buf || buf.length === 0) {
    log.error('voice-extract', 'encoded MP3 buffer is empty');
    return null;
  }
  // Reconcile bytes: trust the actual buffer length when the
  // stderr-parsed value is 0.
  const finalBytes = acceptedBytes > 0 ? acceptedBytes : buf.length;

  const r2Key = `channel-clone-voice/${workspaceId}/${jobId}.mp3`;
  try {
    await uploadToBucket(getReviewBucket(), r2Key, buf, 'audio/mpeg');
  } catch (err) {
    log.error('voice-extract', 'R2 upload failed', { r2Key, error: errorMessage(err) });
    return null;
  }

  // 6. Persist on the job state. Merge so we don't clobber any
  //    progressLog appends that landed concurrently.
  const voiceSample = {
    r2Key,
    sourceVideoId: chosen.videoId,
    startSec: acceptedStartSec,
    durationSec: WINDOW_DURATION_SEC,
    bytes: finalBytes,
    extractedAt: new Date().toISOString(),
  };
  try {
    await mergeChannelCloneJobState(jobId, workspaceId, { voiceSample });
  } catch (err) {
    log.error('voice-extract', 'persist failed', { error: errorMessage(err) });
    // R2 object stays — orphan; lifecycle rule will reap if any.
    return null;
  }

  log.info('voice-extract', 'done', voiceSample);
  logger.info('[channel-clone voice-extract] done', { jobId, ...voiceSample });
  return voiceSample;
}

/** Choose the source video with the longest cleaned transcript. Ties
 *  broken by lower `videoId` for determinism. Returns null when there
 *  are no sample videos at all. Exported for unit testing. */
export function pickDensestNarrationVideo(
  sampleVideos: ChannelCloneSampleVideo[],
): ChannelCloneSampleVideo | null {
  if (sampleVideos.length === 0) return null;
  let best: ChannelCloneSampleVideo | null = null;
  let bestWords = -1;
  for (const v of sampleVideos) {
    const words = v.transcript?.wordCount ?? 0;
    // Prefer >0 over the bare fallback of "first video".
    if (words > bestWords) {
      best = v;
      bestWords = words;
    } else if (words === bestWords && best && v.videoId < best.videoId) {
      best = v;
    }
  }
  return best;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

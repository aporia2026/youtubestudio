/**
 * Channel-clone manual-upload intake runner.
 *
 * Companion to `intake-runner.ts` for the YouTube-API-free path:
 * the operator uploads their own reference videos (browser → R2
 * via presigned PUT), this runner pulls them into a sandbox, runs
 * ffmpeg to extract sample frames, and uses operator-provided
 * transcripts directly. No yt-dlp, no cookies, no YouTube API —
 * the entire YouTube anti-bot surface is bypassed.
 *
 * The output shape matches `intake-runner.ts` so every downstream
 * stage (analyze, topics, hooks, script, rowify, publish-pack,
 * handoff) works unchanged.
 *
 * R2 cleanup: after the runner reads the video bytes back into the
 * sandbox, the source object is `deleteFromBucket`-ed so a 50 MB
 * upload doesn't sit on the storage bill forever. If the run fails
 * the object is still cleaned up by the finally block — the
 * operator can re-upload on retry.
 */

import { logger } from '@/lib/logger';
import {
  deleteFromBucket,
  getDownloadUrlForBucket,
  getReviewBucket,
} from '@/lib/r2';
import { cleanCaptions } from './clean-captions';
import { extractFrames } from './ffmpeg';
import {
  isChannelCloneJobCancelled,
  mergeChannelCloneJobState,
  setChannelCloneJobStatus,
  setChannelCloneJobStatusUnlessCancelled,
} from './job-store';
import { makeJobLogger, type JobLogger } from './job-logger';
import {
  createUploadSandbox,
  destroyUploadSandbox,
  runInSandbox,
  type UploadSandbox,
} from './sandbox-runtime';
import type {
  ChannelCloneIntakeResult,
  ChannelCloneSampleVideo,
  CleanedTranscript,
} from './types';

export interface UploadedVideoInput {
  /** R2 object key inside the review bucket. Shape:
   *    channel-clone-uploads/<workspaceId>/<uuid>.<ext>
   *  Validated upstream by /api/channel-clone/intake-upload. */
  r2Key: string;
  /** Display title for the video — defaults to the uploaded
   *  filename minus extension. Surfaced in the analyze stage as
   *  the per-video header. */
  title: string;
  /** Operator-pasted transcript text. Optional but strongly
   *  recommended — the analyze stage needs textual content to do
   *  its job and can't transcribe audio itself. Two formats are
   *  supported:
   *    - Raw plain text: split into one TranscriptLine at t=0.
   *    - SRT (auto-detected via the timecode pattern): parsed by
   *      `cleanCaptions` so per-line timing is preserved. */
  transcript: string;
}

export interface RunUploadIntakeOptions {
  jobId: string;
  workspaceId: string;
  /** Per-job frame interval — same UX as the YouTube intake. */
  frameIntervalSec: 5 | 10 | 15;
  videos: UploadedVideoInput[];
  /** Free-form display label for `sourceChannelName` on the job
   *  row. The user can type "Doodle Explainers I admire" or
   *  similar; defaults to the first video's title when empty. */
  sourceLabel: string;
}

/** Per-step cancel + DB call timeout. Generous because the
 *  serverless function's maxDuration is the real backstop. */
const TIMEOUT_FETCH_VIDEO_MS = 4 * 60 * 1000;

export async function runUploadIntake(opts: RunUploadIntakeOptions): Promise<void> {
  const { jobId, workspaceId, frameIntervalSec, videos, sourceLabel } = opts;
  logger.info('[channel-clone intake-upload] start', { jobId, videoCount: videos.length, frameIntervalSec });
  await setChannelCloneJobStatus(jobId, workspaceId, 'intake_running');

  const log: JobLogger = makeJobLogger(jobId, workspaceId, 'intake-upload');
  log.info('intake', 'start', { videoCount: videos.length, frameIntervalSec, sourceLabel });

  let uploadSandbox: UploadSandbox;
  try {
    uploadSandbox = await createUploadSandbox(jobId, log);
  } catch (err) {
    log.error('sandbox', 'create failed', { error: errorMessage(err) });
    return failJob(jobId, workspaceId, `Could not start intake sandbox: ${errorMessage(err)}`);
  }

  const r2KeysToCleanup: string[] = [];
  const r2Bucket = getReviewBucket();
  try {
    const { sandbox, workDir, ffmpegPath } = uploadSandbox;
    const sandboxJobDir = `${workDir}/intake-${jobId}`;
    await sandbox.mkDir(sandboxJobDir);

    const isCancelled = async (): Promise<boolean> => {
      const cancelled = await isChannelCloneJobCancelled(jobId, workspaceId).catch(() => false);
      if (cancelled) log.warn('intake', 'cancellation requested — bailing out');
      return cancelled;
    };
    if (await isCancelled()) return;

    const sampleVideos: ChannelCloneSampleVideo[] = [];
    let sourceChannelName: string | null = sourceLabel.trim() || null;

    for (const [i, video] of videos.entries()) {
      if (await isCancelled()) return;
      log.info('intake', `processing video ${i + 1}/${videos.length}`, { title: video.title });
      r2KeysToCleanup.push(video.r2Key);
      try {
        // Filename inside the sandbox. Extension is preserved from
        // the R2 key so ffmpeg auto-detects container/codec.
        const ext = inferExtensionFromKey(video.r2Key) ?? 'mp4';
        const videoSandboxPath = `${sandboxJobDir}/video-${i}.${ext}`;

        // Mint a short-lived presigned GET URL for the R2 object,
        // then curl it into the sandbox. The presigned URL signs the
        // specific GET op so even though it's transmitted in the
        // sandbox process list, it only unlocks read access to this
        // one object for the next 7 days.
        log.info('intake', 'downloading from R2 into sandbox', { videoIndex: i, r2Key: video.r2Key });
        const downloadUrl = await getDownloadUrlForBucket(r2Bucket, video.r2Key);
        const dl = await runInSandbox(sandbox, {
          cmd: 'curl',
          args: ['-fsSL', '-o', videoSandboxPath, downloadUrl],
          timeoutMs: TIMEOUT_FETCH_VIDEO_MS,
        });
        if (dl.exitCode !== 0) {
          throw new Error(`curl exited with code ${dl.exitCode}: ${dl.stderr.slice(-2000).trim()}`);
        }

        const frameDir = `${sandboxJobDir}/frames-${i}`;
        const framesResult = await extractFrames(
          sandbox,
          ffmpegPath,
          videoSandboxPath,
          frameDir,
          { intervalSec: frameIntervalSec },
          log,
        );

        // Parse operator-pasted transcript (if provided).
        const transcript = parseTranscript(video.transcript);

        // Read the representative middle frame for the analyze
        // stage. Same mid-video heuristic as intake-runner.ts.
        let representativeFrameBase64: string | null = null;
        let representativeFrameMimeType: 'image/jpeg' | 'image/png' | null = null;
        const frames = framesResult.frameSandboxPaths;
        if (frames.length > 0) {
          const midPath = frames[Math.floor(frames.length / 2)];
          try {
            const buf = await sandbox.readFileToBuffer({ path: midPath });
            if (buf) {
              representativeFrameBase64 = buf.toString('base64');
              representativeFrameMimeType = midPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
            }
          } catch (err) {
            log.warn('intake', 'representative frame read failed', {
              videoIndex: i,
              error: errorMessage(err),
            });
          }
        }

        // Probe the video's duration so the downstream pacing math
        // still has a real number — ffprobe is bundled with the
        // imageio-ffmpeg static build via the same binary's
        // -show_format flag, but ffmpeg standalone works too.
        const durSec = await probeDurationSec(sandbox, ffmpegPath, videoSandboxPath).catch(() => 0);

        sampleVideos.push({
          // We store the R2 key (not a presigned URL) so the row
          // stays valid past the URL's 7-day TTL. If a later stage
          // needs to fetch the bytes again it can re-mint a URL.
          videoUrl: `r2://${r2Bucket}/${video.r2Key}`,
          // Synthetic id derived from index — keeps the existing
          // `string` videoId contract without faking an 11-char
          // YouTube id (which would lie about provenance).
          videoId: `upload-${i + 1}`,
          title: video.title,
          durationSec: Math.round(durSec),
          frameCount: frames.length,
          representativeFrameBase64,
          representativeFrameMimeType,
          transcript,
        });
        sourceChannelName = sourceChannelName ?? video.title;
        log.info('intake', `video ${i + 1}/${videos.length} done`, {
          frames: frames.length,
          transcript: transcript ? `${transcript.wordCount} words` : 'none',
          durationSec: Math.round(durSec),
        });
      } catch (err) {
        log.warn('intake', `video ${i + 1}/${videos.length} failed; skipping`, {
          error: errorMessage(err),
        });
        continue;
      }
    }

    if (sampleVideos.length === 0) {
      log.error('intake', 'all uploads failed during frame-extract');
      return failJob(jobId, workspaceId, 'All uploads failed during frame-extract. Check the file format and re-upload.');
    }

    if (await isCancelled()) return;

    const intakeResult: ChannelCloneIntakeResult = {
      sourceChannelUrl: 'upload://manual',
      sourceChannelHandle: null,
      sourceChannelName,
      sampleVideos,
      fetchedAt: new Date().toISOString(),
    };
    await mergeChannelCloneJobState(jobId, workspaceId, { intake: intakeResult });
    const flipped = await setChannelCloneJobStatusUnlessCancelled(jobId, workspaceId, 'intake_complete');
    if (!flipped) {
      log.warn('intake', 'cancellation landed during final write — staying on cancelled');
      return;
    }
    log.info('intake', 'done', {
      sampleVideoCount: sampleVideos.length,
      totalFrames: sampleVideos.reduce((acc, v) => acc + v.frameCount, 0),
      transcriptsAvailable: sampleVideos.filter((v) => v.transcript).length,
      framesAvailable: sampleVideos.filter((v) => v.representativeFrameBase64).length,
    });
  } finally {
    await destroyUploadSandbox(jobId, uploadSandbox, log);
    // R2 cleanup runs regardless of outcome. Per-key errors are
    // swallowed so a slow delete doesn't bubble back to the user;
    // orphan objects can be reaped by an R2 lifecycle rule on the
    // channel-clone-uploads/ prefix.
    for (const key of r2KeysToCleanup) {
      deleteFromBucket(r2Bucket, key).catch((err) => {
        logger.warn('[channel-clone intake-upload] r2 delete failed', {
          jobId,
          r2Key: key,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}

async function failJob(jobId: string, workspaceId: string, message: string): Promise<void> {
  logger.error('[channel-clone intake-upload] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, 'intake_failed', { lastError: message });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inferExtensionFromKey(r2Key: string): string | null {
  const m = /\.([a-z0-9]{2,5})$/i.exec(r2Key);
  return m ? m[1].toLowerCase() : null;
}

/** Parse the operator-pasted transcript. Auto-detects SRT format
 *  via the well-known `\d+\n\d{2}:\d{2}:\d{2},\d{3} -->` pattern;
 *  falls back to treating the whole blob as a single line at t=0
 *  when no SRT structure is found. Empty input returns null so
 *  the analyze stage's `transcript ? ... : null` branch fires. */
function parseTranscript(raw: string): CleanedTranscript | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // SRT format detection — at least one timecode arrow.
  if (/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(trimmed)) {
    try {
      return cleanCaptions(trimmed);
    } catch {
      // Fall through to plain-text branch.
    }
  }
  // Plain text — one line at t=0 with the whole pasted blob.
  const text = trimmed.replace(/\s+/g, ' ');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return {
    sourceFormat: 'srt',
    wordCount,
    durationSec: 0,
    lines: [{ startSec: 0, text }],
  };
}

/** Use ffmpeg itself (no ffprobe needed) to print the video's
 *  duration. `-i` on a video file emits "Duration: hh:mm:ss.ms"
 *  to stderr; we parse it. Returns 0 on any failure so the
 *  downstream math has a safe default. */
async function probeDurationSec(sandbox: UploadSandbox['sandbox'], ffmpegPath: string, videoSandboxPath: string): Promise<number> {
  const probe = await runInSandbox(sandbox, {
    cmd: ffmpegPath,
    args: ['-hide_banner', '-i', videoSandboxPath, '-f', 'null', '-'],
    timeoutMs: 30_000,
  });
  // ffmpeg prints to stderr even on success here, and exits with
  // code 0 on the `-f null` no-op output.
  const m = /Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/.exec(probe.stderr);
  if (!m) return 0;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const centi = Number(m[4]);
  return hours * 3600 + minutes * 60 + seconds + centi / 100;
}

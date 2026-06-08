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
  uploadToBucket,
} from '@/lib/r2';
import { cleanCaptions } from './clean-captions';
import { extractFrames } from './ffmpeg';
import {
  estimateDurationSecFromWords,
  parseFfmpegDuration,
} from './parse-ffmpeg-duration';
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
import { runVoiceExtractDuringIntake } from './voice-extract-during-intake';
import { runVoiceProfile } from './voice-profile-runner';

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
  /** Optional source YouTube channel URL. Lets the analyze +
   *  publish-pack stages reason about the actual channel (handle,
   *  niche, similar channels) and not just the operator-uploaded
   *  videos. Validated upstream by /api/channel-clone/intake-upload
   *  via the same `validateYoutubeUrl` used by the URL intake. */
  sourceChannelUrl?: string;
  sourceChannelHandle?: string | null;
}

/** Per-step cancel + DB call timeout. Generous because the
 *  serverless function's maxDuration is the real backstop. */
const TIMEOUT_FETCH_VIDEO_MS = 4 * 60 * 1000;

/** Concurrent frame-uploads per video. R2 PutObject is cheap so we
 *  could go higher, but 4 keeps the sandbox→Vercel→R2 hop chain
 *  from saturating on a slow network without dragging the wall-
 *  clock. ~30 frames × 50 KB / 4 = ~7 batches, each ~1 s. */
const FRAME_UPLOAD_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` in flight at once,
 *  preserving order in the result. Mirrors the client-side helper in
 *  ChannelCloneUploadForm.tsx but server-side for the frame uploads. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function runUploadIntake(opts: RunUploadIntakeOptions): Promise<void> {
  const { jobId, workspaceId, frameIntervalSec, videos, sourceLabel, sourceChannelUrl, sourceChannelHandle } = opts;
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

  /** Fresh uploads (`channel-clone-uploads/<ws>/<uuid>.<ext>`) — copy
   *  to the per-job staging prefix, then delete the original. */
  const freshKeysToStageAndDelete: string[] = [];
  /** Library-reuse keys (`channel-clone-uploads-staging/<ws>/<oldJobId>/
   *  ...`). Do NOT delete — the originating job still surfaces them in
   *  the "pick from previous uploads" picker. Re-stage them under the
   *  new job's prefix so save-as-template on this new job sees its
   *  full set of staging keys. 2026-06-08 — when adding the picker. */
  const libraryKeysToStageOnly: string[] = [];
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
    // Per-video sandbox path keyed by the synthetic videoId. Built
    // up during the loop so the voice-extract step (Plan 1A) can
    // re-encode an audio window from the already-downloaded MP4
    // without spinning up a second sandbox.
    const videoSandboxPaths: Record<string, string> = {};
    let sourceChannelName: string | null = sourceLabel.trim() || null;

    for (const [i, video] of videos.entries()) {
      if (await isCancelled()) return;
      log.info('intake', `processing video ${i + 1}/${videos.length}`, { title: video.title });
      const isLibraryReuse = video.r2Key.startsWith('channel-clone-uploads-staging/');
      if (isLibraryReuse) {
        libraryKeysToStageOnly.push(video.r2Key);
      } else {
        freshKeysToStageAndDelete.push(video.r2Key);
      }
      try {
        // Filename inside the sandbox. Extension is preserved from
        // the R2 key so ffmpeg auto-detects container/codec.
        const ext = inferExtensionFromKey(video.r2Key) ?? 'mp4';
        const videoSandboxPath = `${sandboxJobDir}/video-${i}.${ext}`;
        videoSandboxPaths[`upload-${i + 1}`] = videoSandboxPath;

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

        // Read every frame back from the sandbox and persist to R2
        // under a job-scoped prefix. The rowify stage later picks a
        // handful of these as bundled refs for the image-gen pipeline
        // — that's what makes the cloned channel's visual DNA actually
        // travel into every generated image.
        //
        // The middle frame ALSO gets base64'd as the per-video
        // representative for the analyze stage (which feeds one still
        // to a multimodal LLM for keyword extraction). The base64 is
        // kept in JSONB; the rest live on R2 with their keys recorded.
        const frames = framesResult.frameSandboxPaths;
        const frameR2Keys: string[] = [];
        let representativeFrameBase64: string | null = null;
        let representativeFrameMimeType: 'image/jpeg' | 'image/png' | null = null;
        if (frames.length > 0) {
          const midIndex = Math.floor(frames.length / 2);
          const uploadResults = await mapWithLimit(frames, FRAME_UPLOAD_CONCURRENCY, async (framePath, fIdx) => {
            try {
              const buf = await sandbox.readFileToBuffer({ path: framePath });
              if (!buf) return null;
              const isPng = framePath.toLowerCase().endsWith('.png');
              const ext = isPng ? 'png' : 'jpg';
              const contentType = isPng ? 'image/png' : 'image/jpeg';
              const r2Key = `channel-clone-frames/${workspaceId}/${jobId}/${i}/${String(fIdx).padStart(3, '0')}.${ext}`;
              await uploadToBucket(r2Bucket, r2Key, buf, contentType);
              if (fIdx === midIndex) {
                representativeFrameBase64 = buf.toString('base64');
                representativeFrameMimeType = isPng ? 'image/png' : 'image/jpeg';
              }
              return r2Key;
            } catch (err) {
              log.warn('intake', `frame ${fIdx} upload to R2 failed; skipping`, {
                videoIndex: i,
                error: errorMessage(err),
              });
              return null;
            }
          });
          for (const k of uploadResults) {
            if (k !== null) frameR2Keys.push(k);
          }
          log.info('intake', 'frames persisted to R2', {
            videoIndex: i,
            extracted: frames.length,
            uploaded: frameR2Keys.length,
          });
        }

        // Probe the video's duration so the downstream pacing math
        // (and the voice-extract window-fit guard) has a real number.
        // ffmpeg's `-i` stderr is what `probeDurationSec` parses;
        // when that fails (regex variant, N/A, malformed file) we
        // fall back to a word-rate estimate derived from the
        // transcript so voice-extract isn't kneecapped by an
        // unparseable duration line. See plan
        // 2026-06-08-voice-extract-duration-fallback.md.
        let durSec = await probeDurationSec(sandbox, ffmpegPath, videoSandboxPath, log).catch((err) => {
          log.warn('intake', 'ffmpeg duration probe threw', {
            error: errorMessage(err),
          });
          return 0;
        });
        if (durSec === 0 && transcript && transcript.wordCount > 0) {
          // Prefer the transcript's own durationSec when SRT-cleaned
          // (cleanCaptions stamps it from the last cue's startSec);
          // otherwise estimate from the word count at 150 wpm.
          if (transcript.durationSec > 0) {
            durSec = transcript.durationSec;
            log.info('intake', 'duration falling back to transcript timestamp', {
              videoIndex: i, durSec,
            });
          } else {
            durSec = estimateDurationSecFromWords(transcript.wordCount);
            log.info('intake', 'duration falling back to word-rate estimate (150 wpm)', {
              videoIndex: i, wordCount: transcript.wordCount, estimatedSec: durSec,
            });
          }
        }

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
          frameR2Keys,
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

    log.info('intake', 'loop finished — persisting intake result', {
      processed: sampleVideos.length,
      requested: videos.length,
    });

    if (sampleVideos.length === 0) {
      log.error('intake', 'all uploads failed during frame-extract');
      return failJob(jobId, workspaceId, 'All uploads failed during frame-extract. Check the file format and re-upload.');
    }

    if (await isCancelled()) return;

    const intakeResult: ChannelCloneIntakeResult = {
      // Prefer the real YouTube channel URL the operator pasted
      // (analyze + publish-pack use this for niche reasoning + sim.
      // -channel suggestions). Falls back to the synthetic
      // `upload://` marker when missing.
      sourceChannelUrl: sourceChannelUrl?.trim() || 'upload://manual',
      sourceChannelHandle: sourceChannelHandle ?? null,
      sourceChannelName,
      sampleVideos,
      fetchedAt: new Date().toISOString(),
    };
    await mergeChannelCloneJobState(jobId, workspaceId, { intake: intakeResult });
    log.info('intake', 'intake result persisted', {
      sampleVideoCount: sampleVideos.length,
    });

    // Voice-extract (Plan 1A — _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md).
    // Best-effort: a failure here logs and returns null without
    // affecting the rest of intake. Done BEFORE flipping status so
    // the operator sees voiceSample available when intake_complete
    // lands in their poll.
    log.info('intake', 'starting voice-extract step');
    try {
      await runVoiceExtractDuringIntake(
        {
          jobId,
          workspaceId,
          sandbox,
          ffmpegPath,
          videoSandboxPaths,
          sampleVideos,
          sandboxJobDir,
        },
        log,
      );
    } catch (err) {
      log.warn('voice-extract', 'unexpected throw — continuing intake', {
        error: errorMessage(err),
      });
    }
    log.info('intake', 'voice-extract step finished — flipping status to complete');

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
    // Source-upload cleanup. Plan 2 (template snapshots) needs the
    // operator's uploaded videos to survive the original-job-deleted
    // case, so we COPY each source object into the per-job staging
    // prefix BEFORE deleting the original. The staging prefix has a
    // 7-day R2 lifecycle rule (see ops docs); if no template is saved
    // within that window, the lifecycle rule reaps it.
    //
    // The staging key is deterministic
    // (`channel-clone-uploads-staging/<wsId>/<jobId>/<i>.<ext>`) so the
    // save-as-template route can reconstruct the list from the job's
    // sampleVideos without us persisting a new state field.
    await stageAndDeleteSourceUploads(jobId, workspaceId, freshKeysToStageAndDelete, libraryKeysToStageOnly, r2Bucket);
  }

  // Voice-profile LLM call (Plan 1A — best-effort, never throws).
  // Runs OUTSIDE the sandbox finally because the LLM call only needs
  // the R2 audio URL. Skipped when voiceSample wasn't persisted (e.g.
  // all sample videos were silent or the encode failed).
  try {
    await runVoiceProfile({ jobId, workspaceId });
  } catch (err) {
    logger.warn('[channel-clone intake-upload] voice-profile threw unexpectedly', {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
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

/** Compute the deterministic staging key for the i-th uploaded
 *  video. Mirrored by `getJobStagingR2Key` in the save-as-template
 *  route — keep the two in sync. */
function stagingKeyForVideo(workspaceId: string, jobId: string, index: number, ext: string): string {
  return `channel-clone-uploads-staging/${workspaceId}/${jobId}/${String(index).padStart(3, '0')}.${ext}`;
}

/** Post-intake R2 cleanup. Two key classes:
 *   - `freshKeys` (under `channel-clone-uploads/<ws>/<uuid>`): copy to
 *     the per-job staging prefix, then DELETE the original. The
 *     original was a one-shot upload landing pad — once the bytes are
 *     in staging we don't need it anywhere else.
 *   - `libraryKeys` (already under `channel-clone-uploads-staging/<ws>/
 *     <oldJobId>/...`): copy to the new job's staging prefix so save-
 *     as-template on this new job sees its full set of keys; but DO
 *     NOT delete the original — the originating job still surfaces
 *     them in the "pick from previous uploads" picker and other future
 *     runs may want to reuse the same video too.
 *
 *  Both copy ops are best-effort and per-key; failures are logged so
 *  a single bad object doesn't strand the rest. */
async function stageAndDeleteSourceUploads(
  jobId: string,
  workspaceId: string,
  freshKeys: string[],
  libraryKeys: string[],
  bucket: string,
): Promise<void> {
  // Lazy-import the R2 copy helper so the existing intake-upload-runner
  // module graph stays compact for callers that never hit this path.
  const { copyR2KeysToPrefix } = await import('./templates-r2');
  const destPrefix = `channel-clone-uploads-staging/${workspaceId}/${jobId}`;
  const allKeysToCopy = [...freshKeys, ...libraryKeys];
  if (allKeysToCopy.length > 0) {
    try {
      const result = await copyR2KeysToPrefix({
        sourceKeys: allKeysToCopy,
        destPrefix,
        bucket,
      });
      logger.info('[channel-clone intake-upload] staging-copy done', {
        jobId, copied: result.copiedKeys.length, failed: result.failedIndices.length,
        freshCount: freshKeys.length, libraryReuseCount: libraryKeys.length,
      });
    } catch (err) {
      logger.warn('[channel-clone intake-upload] staging-copy threw', {
        jobId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // R2 source delete runs only for FRESH uploads. Library-reuse keys
  // are left in place so the originating job's picker entry survives.
  for (const key of freshKeys) {
    void stagingKeyForVideo; // referenced for the export-only helper above
    deleteFromBucket(bucket, key).catch((err) => {
      logger.warn('[channel-clone intake-upload] r2 delete failed', {
        jobId, r2Key: key,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/** Exported for the save-template route which reconstructs the
 *  staging key list from a job's intake.sampleVideos. Keep in sync
 *  with `stagingKeyForVideo` above. */
export function buildStagingKeyForJob(workspaceId: string, jobId: string, index: number, ext: string): string {
  return stagingKeyForVideo(workspaceId, jobId, index, ext);
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
 *  duration. `-i` on a video file emits "Duration: ..." to stderr; the
 *  pure parser in `parse-ffmpeg-duration.ts` handles the format
 *  variations (1-2 digit fields, 0-6 digit fractional seconds, N/A).
 *  Returns 0 on any failure so the downstream math has a safe default,
 *  but logs a diagnostic so the silent-failure we hit on 2026-06-07
 *  doesn't recur unseen. */
async function probeDurationSec(
  sandbox: UploadSandbox['sandbox'],
  ffmpegPath: string,
  videoSandboxPath: string,
  log: JobLogger,
): Promise<number> {
  const probe = await runInSandbox(sandbox, {
    cmd: ffmpegPath,
    args: ['-hide_banner', '-i', videoSandboxPath, '-f', 'null', '-'],
    timeoutMs: 30_000,
  });
  // ffmpeg prints to stderr even on success here, and exits with
  // code 0 on the `-f null` no-op output.
  const parsed = parseFfmpegDuration(probe.stderr);
  if (parsed.seconds !== null && parsed.seconds > 0) {
    return parsed.seconds;
  }
  // Surface the tail of stderr so we can see what ffmpeg actually
  // emitted next time this fires — cap at 800 chars to keep the log
  // row readable in the live UI.
  const stderrTail = probe.stderr.slice(-800).trim();
  log.warn('intake', 'ffmpeg duration probe returned no usable value', {
    videoSandboxPath,
    exitCode: probe.exitCode,
    matchedText: parsed.matchedText,
    stderrTail,
  });
  return 0;
}

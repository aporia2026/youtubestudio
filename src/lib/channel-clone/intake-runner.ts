/**
 * Channel-clone intake runner.
 *
 * Coordinates the per-job work inside a Vercel Sandbox microVM
 * (yt-dlp + ffmpeg) and drops the analyze stage's inputs onto the
 * job's `state_jsonb.intake`:
 *   1. Resolve the user-supplied URL to a canonical channel URL
 *      (yt-dlp probe — handles `/watch?v=` paste → owner channel).
 *   2. List the latest N long-form videos from that channel.
 *   3. For each video, download at 480p + auto-captions.
 *   4. Extract sample frames every N seconds.
 *   5. Read the cleaned transcript + representative middle frame
 *      back from the sandbox into the job state, discard the rest.
 *
 * Stops the sandbox in a `finally` so a thrown error doesn't orphan
 * a microVM. The function returns a 202 with the job id and then
 * `void runIntake(...)` so the user's browser doesn't block on the
 * multi-minute work. Status updates land on the job row so the UI
 * can poll.
 *
 * Failure modes are captured into `last_error` and bump the status
 * to `intake_failed`; the caller does NOT throw to the Route Handler.
 */

import path from 'path';
import { logger } from '@/lib/logger';
import { getReviewBucket, uploadToBucket } from '@/lib/r2';
import { cleanCaptions } from './clean-captions';
import { extractFrames } from './ffmpeg';
import {
  isChannelCloneJobCancelled,
  mergeChannelCloneJobState,
  setChannelCloneJobStatus,
  setChannelCloneJobStatusUnlessCancelled,
} from './job-store';
import { makeJobLogger, type JobLogger } from './job-logger';
import { createIntakeSandbox, destroyIntakeSandbox, type IntakeSandbox } from './sandbox-runtime';
import type { ChannelCloneIntakeResult, ChannelCloneSampleVideo } from './types';
import { downloadVideo, listChannelVideos } from './yt-dlp';

export interface RunIntakeOptions {
  jobId: string;
  workspaceId: string;
  canonicalUrl: string;
  /** When the user pasted a video URL we still need to resolve to
   *  its owner channel before listing peers. The intake runner
   *  delegates that to yt-dlp's metadata probe. */
  kind: 'channel' | 'video';
  /** Per-settings: 3 / 5 / 8 sample videos. */
  sampleVideoCount: 3 | 5 | 8;
  /** Per-settings: 5 / 10 / 15 second frame interval. */
  frameIntervalSec: 5 | 10 | 15;
}

/** Run the full intake pipeline for one job. Never throws — all
 *  failures are captured on the job row. */
export async function runIntake(opts: RunIntakeOptions): Promise<void> {
  const { jobId, workspaceId, canonicalUrl, kind, sampleVideoCount, frameIntervalSec } = opts;
  logger.info('[channel-clone intake] start', { jobId, canonicalUrl, kind, sampleVideoCount, frameIntervalSec });

  await setChannelCloneJobStatus(jobId, workspaceId, 'intake_running');

  // Job-scoped logger writes to BOTH the server log AND the job row's
  // progressLog so the panel can stream live progress. Created here
  // (rather than inside createIntakeSandbox) so it's available for the
  // sandbox-creation failure path too.
  const log: JobLogger = makeJobLogger(jobId, workspaceId, 'intake');
  log.info('intake', 'start', { canonicalUrl, kind, sampleVideoCount, frameIntervalSec });

  let intakeSandbox: IntakeSandbox;
  try {
    intakeSandbox = await createIntakeSandbox(jobId, log);
  } catch (err) {
    log.error('sandbox', 'create failed', { error: errorMessage(err) });
    return failJob(jobId, workspaceId, `Could not start intake sandbox: ${errorMessage(err)}`);
  }

  try {
    const { sandbox, workDir, ffmpegPath, cookiesPath } = intakeSandbox;
    // Per-job working directory inside the sandbox. Sandbox is
    // ephemeral so we don't need a unique suffix — the whole VM is
    // torn down at the end.
    const sandboxJobDir = `${workDir}/intake-${jobId}`;
    await sandbox.mkDir(sandboxJobDir);

    // Cancellation checkpoint helper — polls the DB once. Cheap (a
    // single index lookup on a small JSONB field). The runner calls
    // this between every major step so the user's cancel button
    // takes effect within a few seconds rather than waiting out the
    // current yt-dlp / ffmpeg invocation.
    const isCancelled = async (): Promise<boolean> => {
      const cancelled = await isChannelCloneJobCancelled(jobId, workspaceId).catch(() => false);
      if (cancelled) log.warn('intake', 'cancellation requested — bailing out');
      return cancelled;
    };
    if (await isCancelled()) return;

    // 1. Resolve to a channel URL when the user pasted a video URL.
    let channelUrl = canonicalUrl;
    if (kind === 'video') {
      try {
        log.info('intake', 'resolving video → owner channel');
        const [probed] = await listChannelVideos(sandbox, cookiesPath, canonicalUrl, { maxVideos: 1 }, log);
        if (probed?.channelUrl) {
          channelUrl = probed.channelUrl;
          log.info('intake', 'resolved owner channel', { channelUrl });
        }
      } catch (err) {
        // Non-fatal: fall back to using the video URL itself as the
        // "channel" probe target. yt-dlp's list will return that one
        // video and we'll proceed with sampleVideoCount=1.
        log.warn('intake', 'video→channel resolution failed; using video URL as channel', { error: errorMessage(err) });
        logger.warn('[channel-clone intake] video→channel resolution failed; using video URL as channel', {
          jobId,
          canonicalUrl,
          error: errorMessage(err),
        });
      }
    }

    if (await isCancelled()) return;

    // 2. List the latest sampleVideoCount long-form videos.
    let videoMetas;
    try {
      videoMetas = await listChannelVideos(sandbox, cookiesPath, channelUrl, { maxVideos: sampleVideoCount }, log);
    } catch (err) {
      log.error('yt-dlp', 'list channel videos failed', { error: errorMessage(err) });
      return failJob(jobId, workspaceId, `Could not list channel videos: ${errorMessage(err)}`);
    }
    if (videoMetas.length === 0) {
      log.error('intake', 'no long-form videos found on this channel');
      return failJob(jobId, workspaceId, 'No long-form videos found on this channel.');
    }

    // 3-5. Download + extract + read-back for each.
    const sampleVideos: ChannelCloneSampleVideo[] = [];
    let sourceChannelHandle: string | null = null;
    let sourceChannelName: string | null = null;
    for (const [i, meta] of videoMetas.entries()) {
      if (await isCancelled()) return;
      log.info('intake', `processing video ${i + 1}/${videoMetas.length}`, { videoId: meta.videoId, title: meta.title });
      try {
        const dl = await downloadVideo(sandbox, ffmpegPath, cookiesPath, meta.videoUrl, sandboxJobDir, log);
        const frameDir = `${sandboxJobDir}/frames-${meta.videoId}`;
        const framesResult = await extractFrames(sandbox, ffmpegPath, dl.videoSandboxPath, frameDir, { intervalSec: frameIntervalSec }, log);

        // Read the cleaned transcript (small) into memory.
        let transcript = null;
        if (dl.transcriptSandboxPath) {
          try {
            const buf = await sandbox.readFileToBuffer({ path: dl.transcriptSandboxPath });
            if (buf) {
              transcript = cleanCaptions(buf.toString('utf8'));
            }
          } catch (err) {
            logger.warn('[channel-clone intake] caption read failed', {
              jobId,
              videoId: meta.videoId,
              error: errorMessage(err),
            });
          }
        }

        // Read every frame back from the sandbox and persist to R2
        // under a job-scoped prefix. The rowify stage later picks a
        // handful of these as bundled refs for the image-gen pipeline
        // — that's what makes the cloned channel's visual DNA actually
        // travel into every generated image. The middle frame is also
        // base64'd as the per-video representative for the analyze
        // stage (which feeds one still to a multimodal LLM for keyword
        // extraction).
        const frames = framesResult.frameSandboxPaths;
        const frameR2Keys: string[] = [];
        let representativeFrameBase64: string | null = null;
        let representativeFrameMimeType: 'image/jpeg' | 'image/png' | null = null;
        if (frames.length > 0) {
          const midIndex = Math.floor(frames.length / 2);
          const r2Bucket = getReviewBucket();
          const uploadResults = await mapWithLimit(frames, FRAME_UPLOAD_CONCURRENCY, async (framePath, fIdx) => {
            try {
              const buf = await sandbox.readFileToBuffer({ path: framePath });
              if (!buf) return null;
              const isPng = path.extname(framePath).toLowerCase() === '.png';
              const ext = isPng ? 'png' : 'jpg';
              const contentType = isPng ? 'image/png' : 'image/jpeg';
              const r2Key = `channel-clone-frames/${workspaceId}/${jobId}/${meta.videoId}/${String(fIdx).padStart(3, '0')}.${ext}`;
              await uploadToBucket(r2Bucket, r2Key, buf, contentType);
              if (fIdx === midIndex) {
                representativeFrameBase64 = buf.toString('base64');
                representativeFrameMimeType = isPng ? 'image/png' : 'image/jpeg';
              }
              return r2Key;
            } catch (err) {
              log.warn('intake', `frame ${fIdx} upload to R2 failed; skipping`, {
                videoId: meta.videoId,
                error: errorMessage(err),
              });
              return null;
            }
          });
          for (const k of uploadResults) {
            if (k !== null) frameR2Keys.push(k);
          }
          log.info('intake', 'frames persisted to R2', {
            videoId: meta.videoId,
            extracted: frames.length,
            uploaded: frameR2Keys.length,
          });
        }

        sampleVideos.push({
          videoUrl: meta.videoUrl,
          videoId: meta.videoId,
          title: meta.title,
          durationSec: meta.durationSec,
          frameCount: frames.length,
          frameR2Keys,
          representativeFrameBase64,
          representativeFrameMimeType,
          transcript,
        });
        // Derive channel display fields from the first successful probe.
        sourceChannelName = sourceChannelName ?? dl.metadata.uploader;
        sourceChannelHandle = sourceChannelHandle ?? extractHandleFromChannelUrl(dl.metadata.channelUrl);
        log.info('intake', `video ${i + 1}/${videoMetas.length} done`, {
          videoId: meta.videoId,
          frames: frames.length,
          transcript: transcript ? `${transcript.wordCount} words` : 'none',
        });
      } catch (err) {
        log.warn('intake', `video ${i + 1}/${videoMetas.length} failed; skipping`, { videoId: meta.videoId, error: errorMessage(err) });
        logger.warn('[channel-clone intake] per-video work failed; skipping', {
          jobId,
          videoId: meta.videoId,
          error: errorMessage(err),
        });
        continue;
      }
    }

    if (sampleVideos.length === 0) {
      log.error('intake', 'all sample videos failed during download/frame-extract');
      return failJob(jobId, workspaceId, 'All sample videos failed during download/frame-extract.');
    }

    if (await isCancelled()) return;

    // Bundle and persist.
    const intakeResult: ChannelCloneIntakeResult = {
      sourceChannelUrl: channelUrl,
      sourceChannelHandle,
      sourceChannelName,
      sampleVideos,
      fetchedAt: new Date().toISOString(),
    };

    // Shallow-merge so the live progressLog appends we've been
    // streaming throughout the run aren't clobbered by a stale
    // snapshot of state_jsonb. The intake field is fully replaced;
    // everything else (progressLog, future stages) is preserved.
    await mergeChannelCloneJobState(jobId, workspaceId, { intake: intakeResult });
    // Conditional flip: if a cancellation landed in the closing
    // milliseconds (after the last isCancelled() check but before
    // this write), the SQL guards the status update so the user's
    // intent wins and we stay on 'cancelled'.
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
    logger.info('[channel-clone intake] done', {
      jobId,
      sampleVideoCount: sampleVideos.length,
      totalFrames: sampleVideos.reduce((acc, v) => acc + v.frameCount, 0),
      transcriptsAvailable: sampleVideos.filter((v) => v.transcript).length,
      framesAvailable: sampleVideos.filter((v) => v.representativeFrameBase64).length,
    });
  } finally {
    // Always stop the sandbox so a thrown error doesn't orphan a
    // microVM. Vercel reaps on the sandbox's own lifetime timeout
    // either way, but explicit stop refunds CPU billing sooner.
    await destroyIntakeSandbox(jobId, intakeSandbox, log);
  }
}

async function failJob(
  jobId: string,
  workspaceId: string,
  message: string,
): Promise<void> {
  logger.error('[channel-clone intake] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, 'intake_failed', { lastError: message });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Concurrent frame-uploads per video. R2 PutObject is cheap so we
 *  could go higher, but 4 keeps the sandbox→Vercel→R2 hop chain
 *  from saturating on a slow network without dragging the wall-
 *  clock. ~30 frames × 50 KB / 4 = ~7 batches, each ~1 s. */
const FRAME_UPLOAD_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` in flight at once,
 *  preserving order in the result. Same worker-pool shape used in
 *  intake-upload-runner.ts; duplicated rather than centralised
 *  because the intake runners are intentionally independent so a
 *  change in one path can't accidentally break the other. */
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

/** Strip a YouTube channel URL down to just its @handle when the
 *  URL is in that shape; returns null otherwise. */
function extractHandleFromChannelUrl(channelUrl: string | null): string | null {
  if (!channelUrl) return null;
  try {
    const u = new URL(channelUrl);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg?.startsWith('@') ? seg : null;
  } catch {
    return null;
  }
}

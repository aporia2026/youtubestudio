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
import { cleanCaptions } from './clean-captions';
import { extractFrames } from './ffmpeg';
import {
  getChannelCloneJob,
  replaceChannelCloneJobState,
  setChannelCloneJobStatus,
} from './job-store';
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

  let intakeSandbox: IntakeSandbox;
  try {
    intakeSandbox = await createIntakeSandbox(jobId);
  } catch (err) {
    return failJob(jobId, workspaceId, `Could not start intake sandbox: ${errorMessage(err)}`);
  }

  try {
    const { sandbox, workDir } = intakeSandbox;
    // Per-job working directory inside the sandbox. Sandbox is
    // ephemeral so we don't need a unique suffix — the whole VM is
    // torn down at the end.
    const sandboxJobDir = `${workDir}/intake-${jobId}`;
    await sandbox.mkDir(sandboxJobDir);

    // 1. Resolve to a channel URL when the user pasted a video URL.
    let channelUrl = canonicalUrl;
    if (kind === 'video') {
      try {
        const [probed] = await listChannelVideos(sandbox, canonicalUrl, { maxVideos: 1 });
        if (probed?.channelUrl) {
          channelUrl = probed.channelUrl;
        }
      } catch (err) {
        // Non-fatal: fall back to using the video URL itself as the
        // "channel" probe target. yt-dlp's list will return that one
        // video and we'll proceed with sampleVideoCount=1.
        logger.warn('[channel-clone intake] video→channel resolution failed; using video URL as channel', {
          jobId,
          canonicalUrl,
          error: errorMessage(err),
        });
      }
    }

    // 2. List the latest sampleVideoCount long-form videos.
    let videoMetas;
    try {
      videoMetas = await listChannelVideos(sandbox, channelUrl, { maxVideos: sampleVideoCount });
    } catch (err) {
      return failJob(jobId, workspaceId, `Could not list channel videos: ${errorMessage(err)}`);
    }
    if (videoMetas.length === 0) {
      return failJob(jobId, workspaceId, 'No long-form videos found on this channel.');
    }

    // 3-5. Download + extract + read-back for each.
    const sampleVideos: ChannelCloneSampleVideo[] = [];
    let sourceChannelHandle: string | null = null;
    let sourceChannelName: string | null = null;
    for (const meta of videoMetas) {
      try {
        const dl = await downloadVideo(sandbox, meta.videoUrl, sandboxJobDir);
        const frameDir = `${sandboxJobDir}/frames-${meta.videoId}`;
        const framesResult = await extractFrames(sandbox, dl.videoSandboxPath, frameDir, { intervalSec: frameIntervalSec });

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

        // Read the representative middle frame back as base64. We
        // discard every other frame — only the analyze stage needs a
        // frame, and only one. Keeping all would bloat the JSONB row.
        let representativeFrameBase64: string | null = null;
        let representativeFrameMimeType: 'image/jpeg' | 'image/png' | null = null;
        const frames = framesResult.frameSandboxPaths;
        if (frames.length > 0) {
          const midPath = frames[Math.floor(frames.length / 2)];
          try {
            const buf = await sandbox.readFileToBuffer({ path: midPath });
            if (buf) {
              representativeFrameBase64 = buf.toString('base64');
              representativeFrameMimeType = path.extname(midPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
            }
          } catch (err) {
            logger.warn('[channel-clone intake] representative frame read failed', {
              jobId,
              videoId: meta.videoId,
              framePath: midPath,
              error: errorMessage(err),
            });
          }
        }

        sampleVideos.push({
          videoUrl: meta.videoUrl,
          videoId: meta.videoId,
          title: meta.title,
          durationSec: meta.durationSec,
          frameCount: frames.length,
          representativeFrameBase64,
          representativeFrameMimeType,
          transcript,
        });
        // Derive channel display fields from the first successful probe.
        sourceChannelName = sourceChannelName ?? dl.metadata.uploader;
        sourceChannelHandle = sourceChannelHandle ?? extractHandleFromChannelUrl(dl.metadata.channelUrl);
      } catch (err) {
        logger.warn('[channel-clone intake] per-video work failed; skipping', {
          jobId,
          videoId: meta.videoId,
          error: errorMessage(err),
        });
        continue;
      }
    }

    if (sampleVideos.length === 0) {
      return failJob(jobId, workspaceId, 'All sample videos failed during download/frame-extract.');
    }

    // Bundle and persist.
    const intakeResult: ChannelCloneIntakeResult = {
      sourceChannelUrl: channelUrl,
      sourceChannelHandle,
      sourceChannelName,
      sampleVideos,
      fetchedAt: new Date().toISOString(),
    };

    const existing = await getChannelCloneJob(jobId, workspaceId);
    if (!existing) {
      logger.error('[channel-clone intake] job vanished mid-run', { jobId });
      return;
    }
    const nextState = { ...existing.state_jsonb, intake: intakeResult };
    await replaceChannelCloneJobState(jobId, workspaceId, nextState);
    await setChannelCloneJobStatus(jobId, workspaceId, 'intake_complete');
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
    await destroyIntakeSandbox(jobId, intakeSandbox);
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

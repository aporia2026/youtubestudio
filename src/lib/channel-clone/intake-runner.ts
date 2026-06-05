/**
 * Channel-clone intake runner.
 *
 * Coordinates the dev-only subprocess work for a single clone job:
 *   1. Resolve the user-supplied URL to a canonical channel URL
 *      (yt-dlp probe — handles `/watch?v=` paste → owner channel).
 *   2. List the latest N long-form videos from that channel.
 *   3. Download each video at 480p + auto-captions.
 *   4. Extract sample frames every N seconds.
 *   5. Clean the captions and bundle the per-video payload onto
 *      the job's `state_jsonb.intake`.
 *
 * Long-running. The Route Handler that fires this returns a 202
 * with the job id and then `void runIntake(...)` so the user's
 * browser doesn't block on the multi-minute work. Status updates
 * land on the job row so the UI can poll.
 *
 * Failure modes are captured into `last_error` and bump the
 * status to `intake_failed`; the caller does NOT throw to the
 * Route Handler.
 */

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '@/lib/logger';
import { cleanCaptions } from './clean-captions';
import { extractFrames } from './ffmpeg';
import {
  getChannelCloneJob,
  replaceChannelCloneJobState,
  setChannelCloneJobStatus,
} from './job-store';
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

  const tempDirPath = path.join(os.tmpdir(), `channel-clone-${jobId}-${randomUUID().slice(0, 8)}`);
  try {
    await fs.mkdir(tempDirPath, { recursive: true });
  } catch (err) {
    return failJob(jobId, workspaceId, 'intake_failed', `Could not create temp dir: ${errorMessage(err)}`);
  }

  // Resolve to a channel URL when the user pasted a video URL.
  let channelUrl = canonicalUrl;
  if (kind === 'video') {
    try {
      const [probed] = await listChannelVideos(canonicalUrl, { maxVideos: 1 });
      if (probed?.channelUrl) {
        channelUrl = probed.channelUrl;
      }
    } catch (err) {
      // Non-fatal: fall back to using the video URL itself as the
      // "channel" probe target. yt-dlp's list will return that
      // one video and we'll proceed with sampleVideoCount=1.
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
    videoMetas = await listChannelVideos(channelUrl, { maxVideos: sampleVideoCount });
  } catch (err) {
    return failJob(jobId, workspaceId, 'intake_failed', `Could not list channel videos: ${errorMessage(err)}`);
  }
  if (videoMetas.length === 0) {
    return failJob(jobId, workspaceId, 'intake_failed', 'No long-form videos found on this channel.');
  }

  // 3-4. Download + extract for each.
  const sampleVideos: ChannelCloneSampleVideo[] = [];
  let sourceChannelHandle: string | null = null;
  let sourceChannelName: string | null = null;
  for (const meta of videoMetas) {
    try {
      const dl = await downloadVideo(meta.videoUrl, tempDirPath);
      const frameDir = path.join(tempDirPath, `frames-${meta.videoId}`);
      const framesResult = await extractFrames(dl.videoLocalPath, frameDir, { intervalSec: frameIntervalSec });
      // Clean captions if we got them.
      let transcript = null;
      if (dl.transcriptLocalPath) {
        try {
          const raw = await fs.readFile(dl.transcriptLocalPath, 'utf8');
          transcript = cleanCaptions(raw);
        } catch (err) {
          logger.warn('[channel-clone intake] caption read failed', {
            jobId,
            videoId: meta.videoId,
            error: errorMessage(err),
          });
        }
      }
      sampleVideos.push({
        videoUrl: meta.videoUrl,
        videoId: meta.videoId,
        title: meta.title,
        durationSec: meta.durationSec,
        videoLocalPath: dl.videoLocalPath,
        frameLocalPaths: framesResult.framePaths,
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
    return failJob(jobId, workspaceId, 'intake_failed', 'All sample videos failed during download/frame-extract.');
  }

  // 5. Bundle and persist.
  const intakeResult: ChannelCloneIntakeResult = {
    sourceChannelUrl: channelUrl,
    sourceChannelHandle,
    sourceChannelName,
    sampleVideos,
    fetchedAt: new Date().toISOString(),
    tempDirPath,
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
    totalFrames: sampleVideos.reduce((acc, v) => acc + v.frameLocalPaths.length, 0),
    transcriptsAvailable: sampleVideos.filter((v) => v.transcript).length,
  });
}

async function failJob(
  jobId: string,
  workspaceId: string,
  status: 'intake_failed',
  message: string,
): Promise<void> {
  logger.error('[channel-clone intake] failed', { jobId, message });
  await setChannelCloneJobStatus(jobId, workspaceId, status, { lastError: message });
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

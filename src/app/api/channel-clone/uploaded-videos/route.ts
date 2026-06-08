/**
 * GET /api/channel-clone/uploaded-videos
 *
 * Workspace-scoped library of every video the operator has uploaded
 * in a previous channel-clone run that still has its bytes available
 * for reuse. Powers the "pick from previous uploads" picker in the
 * upload form so a new run can mix selected-from-library entries
 * with freshly-uploaded files.
 *
 * Source of truth: channel_clone_jobs whose state_jsonb.intake has
 * sample videos that point at r2://... staging keys. For each sample
 * video we HEAD-probe the deterministic staging key
 * `channel-clone-uploads-staging/<wsId>/<jobId>/<i>.<ext>` (written
 * by intake-upload-runner's stage step at end of intake). Keys that
 * no longer exist on R2 are filtered out.
 *
 * Each library entry carries the staging r2Key, the operator's title,
 * the original transcript (joined back to plain text from
 * CleanedTranscript), the source job's id + sourceChannelName, the
 * duration, and the row's timestamps. Enough for the picker to show
 * a useful list and for the intake-upload route to ingest the
 * selected entries without operator re-upload.
 *
 * 2026-06-08 — user explicitly asked for video-level picking, not
 * job-level reuse.
 */

import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { listChannelCloneJobs } from '@/lib/channel-clone/job-store';
import { buildStagingKeyForJob } from '@/lib/channel-clone/intake-upload-runner';
import { checkR2KeysExist, inferExtensionFromKey } from '@/lib/channel-clone/templates-r2';
import type { CleanedTranscript } from '@/lib/channel-clone/types';

interface UploadedVideoEntry {
  /** Staging-prefix R2 key. Passed verbatim to intake-upload as the
   *  video's r2Key field. */
  r2Key: string;
  title: string;
  /** Plain-text transcript (lines joined with newlines). May be
   *  empty when the original run was uploaded without one. */
  transcript: string;
  transcriptWordCount: number;
  durationSec: number;
  sourceJobId: string;
  sourceJobName: string | null;
  sourceJobCreatedAt: string;
  sourceVideoIndex: number;
}

function linesToText(transcript: CleanedTranscript | null | undefined): string {
  if (!transcript) return '';
  return transcript.lines.map((l) => l.text).join('\n').trim();
}

function extractOriginalKeyFromVideoUrl(videoUrl: string): string {
  const m = /^r2:\/\/[^/]+\/(.+)$/.exec(videoUrl);
  return m ? m[1] : videoUrl;
}

export const GET = apiRoute.authed(async (session) => {
  const jobs = await listChannelCloneJobs(session.ws, 200);

  // 1) Collect every plausible reusable entry across all upload-
  //    intake jobs in the workspace.
  const candidates: UploadedVideoEntry[] = [];
  for (const job of jobs) {
    const intake = job.state_jsonb.intake;
    if (!intake) continue;
    const isUpload = intake.sampleVideos.every((v) => v.videoUrl.startsWith('r2://'));
    if (!isUpload) continue;
    intake.sampleVideos.forEach((video, i) => {
      const origKey = extractOriginalKeyFromVideoUrl(video.videoUrl);
      const ext = inferExtensionFromKey(origKey) ?? 'mp4';
      const stagingKey = buildStagingKeyForJob(session.ws, job.id, i, ext);
      candidates.push({
        r2Key: stagingKey,
        title: video.title,
        transcript: linesToText(video.transcript),
        transcriptWordCount: video.transcript?.wordCount ?? 0,
        durationSec: video.durationSec,
        sourceJobId: job.id,
        sourceJobName: intake.sourceChannelName ?? null,
        sourceJobCreatedAt: job.created_at,
        sourceVideoIndex: i,
      });
    });
  }

  if (candidates.length === 0) {
    return NextResponse.json({ videos: [], totalRunsScanned: jobs.length });
  }

  // 2) Existence check in batches so a workspace with hundreds of
  //    cached uploads doesn't pile up too many HEAD calls. The
  //    staging prefix has no TTL since 2026-06-08 commit 4ec629ab,
  //    so most entries should exist — failed lookups are the
  //    exceptional case (manually-cleaned jobs, R2 eventual
  //    consistency on a very recent delete).
  const allKeys = candidates.map((c) => c.r2Key);
  const existence = await checkR2KeysExist(allKeys);
  const alive = new Map(existence.map((e) => [e.r2Key, e.exists]));
  const surviving = candidates.filter((c) => alive.get(c.r2Key) === true);

  // 3) Dedupe by R2 key — if the same staging key ended up on
  //    multiple jobs (template reuse, etc.) prefer the entry with
  //    the latest sourceJobCreatedAt so the picker shows the most
  //    recent label.
  const dedup = new Map<string, UploadedVideoEntry>();
  for (const entry of surviving) {
    const existing = dedup.get(entry.r2Key);
    if (!existing || existing.sourceJobCreatedAt < entry.sourceJobCreatedAt) {
      dedup.set(entry.r2Key, entry);
    }
  }

  // 4) Sort most-recent first.
  const videos = [...dedup.values()].sort(
    (a, b) => b.sourceJobCreatedAt.localeCompare(a.sourceJobCreatedAt),
  );

  return NextResponse.json({
    videos,
    totalRunsScanned: jobs.length,
    reusableCount: videos.length,
    expiredCount: candidates.length - surviving.length,
  });
});

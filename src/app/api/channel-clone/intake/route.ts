/**
 * POST /api/channel-clone/intake
 *
 * Kicks off a channel-clone intake job. Body: { url, sampleVideoCount?, frameIntervalSec? }.
 *
 * 202 + { jobId } returned immediately. The actual work (yt-dlp +
 * ffmpeg + caption cleaning, all inside a Vercel Sandbox microVM)
 * runs in `after()` so the function instance stays alive for up to
 * `maxDuration` seconds after the response goes out. Without
 * `after()`, the runtime would terminate the instance the moment
 * the 202 is written and runIntake's DB / sandbox calls would
 * silently die mid-flight — producing the symptom "INTAKE RUNNING
 * but no progress logs ever appear".
 *
 * maxDuration = 300: a 5-video intake at 480p needs ~30s sandbox
 * setup + ~15s/video. 300s covers the slow case (slow YouTube
 * response, retry, etc.) with comfortable margin.
 */

import { after, NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { createChannelCloneJob } from '@/lib/channel-clone/job-store';
import { runIntake } from '@/lib/channel-clone/intake-runner';
import { validateYoutubeUrl } from '@/lib/channel-clone/validate-youtube-url';

export const maxDuration = 300;

const VALID_SAMPLE_COUNTS = new Set([3, 5, 8]);
const VALID_FRAME_INTERVALS = new Set([5, 10, 15]);

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const rawUrl = typeof b.url === 'string' ? b.url : '';
  if (!rawUrl) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 });
  }
  const validation = validateYoutubeUrl(rawUrl);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const sampleVideoCount = Number(b.sampleVideoCount ?? 5);
  if (!VALID_SAMPLE_COUNTS.has(sampleVideoCount)) {
    return NextResponse.json(
      { error: `sampleVideoCount must be one of ${[...VALID_SAMPLE_COUNTS].join(', ')}` },
      { status: 400 },
    );
  }
  const frameIntervalSec = Number(b.frameIntervalSec ?? 10);
  if (!VALID_FRAME_INTERVALS.has(frameIntervalSec)) {
    return NextResponse.json(
      { error: `frameIntervalSec must be one of ${[...VALID_FRAME_INTERVALS].join(', ')}` },
      { status: 400 },
    );
  }

  const jobId = await createChannelCloneJob({
    workspaceId: session.ws,
    userId: session.uid,
    sourceChannelUrl: rawUrl,
    sourceCanonicalUrl: validation.parsed.canonical,
  });

  logger.info('[channel-clone intake] kickoff', {
    jobId,
    workspaceId: session.ws,
    userId: session.uid,
    canonicalUrl: validation.parsed.canonical,
    kind: validation.parsed.kind,
    sampleVideoCount,
    frameIntervalSec,
  });

  // Schedule the runner via `after()` so the Vercel runtime keeps
  // the instance alive for up to `maxDuration` seconds after the
  // 202 goes out. The runner persists status + last_error + the
  // progressLog on the job row so the client can poll for progress.
  // We never throw from here — even if the runner crashes its
  // error lands on the row + a server log via the catch.
  after(async () => {
    try {
      await runIntake({
        jobId,
        workspaceId: session.ws,
        canonicalUrl: validation.parsed.canonical,
        kind: validation.parsed.kind,
        sampleVideoCount: sampleVideoCount as 3 | 5 | 8,
        frameIntervalSec: frameIntervalSec as 5 | 10 | 15,
      });
    } catch (err) {
      logger.error('[channel-clone intake] runner crashed', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return NextResponse.json({ jobId }, { status: 202 });
});

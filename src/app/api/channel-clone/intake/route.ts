/**
 * POST /api/channel-clone/intake
 *
 * Kicks off a channel-clone intake job. Body: { url, sampleVideoCount?, frameIntervalSec? }.
 *
 * 202 + { jobId } returned immediately. The actual subprocess work
 * (yt-dlp + ffmpeg + caption cleaning) runs in the background via
 * `void runIntake(...)` because it can take 2–5 minutes; the user
 * polls `GET /api/channel-clone/jobs/[id]` for status.
 *
 * Dev-only: the intake runner asserts NODE_ENV !== 'production'
 * unless CHANNEL_CLONE_ALLOW_PROD_INTAKE is set, because yt-dlp
 * + ffmpeg can't run inside deployed Vercel functions without a
 * custom runtime image. See `src/lib/channel-clone/yt-dlp.ts`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { createChannelCloneJob } from '@/lib/channel-clone/job-store';
import { runIntake } from '@/lib/channel-clone/intake-runner';
import { validateYoutubeUrl } from '@/lib/channel-clone/validate-youtube-url';

export const maxDuration = 30;

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

  // Fire-and-forget. The runner persists status + last_error on the
  // job row so the client can poll for progress. We never throw from
  // here — even if the runner crashes its error lands on the row.
  void runIntake({
    jobId,
    workspaceId: session.ws,
    canonicalUrl: validation.parsed.canonical,
    kind: validation.parsed.kind,
    sampleVideoCount: sampleVideoCount as 3 | 5 | 8,
    frameIntervalSec: frameIntervalSec as 5 | 10 | 15,
  }).catch((err) => {
    logger.error('[channel-clone intake] runner crashed', {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return NextResponse.json({ jobId }, { status: 202 });
});

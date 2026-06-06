/**
 * POST /api/channel-clone/intake-upload
 *
 * Kicks off a manual-upload intake job. Body:
 *   {
 *     sourceLabel: string,                // free-form display name
 *     frameIntervalSec?: 5 | 10 | 15,     // default 10
 *     videos: [
 *       { blobUrl, title, transcript }    // transcript is optional
 *     ]
 *   }
 *
 * 202 + { jobId } returned immediately. The runner runs in
 * `after()` so the function instance stays alive for the full
 * intake (same pattern as the YouTube intake route — without
 * after(), the runner gets killed mid-flight).
 *
 * Workspace + auth scoped via `apiRoute.authed`.
 */

import { after, NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { createChannelCloneJob } from '@/lib/channel-clone/job-store';
import { runUploadIntake, type UploadedVideoInput } from '@/lib/channel-clone/intake-upload-runner';

export const maxDuration = 300;

const VALID_FRAME_INTERVALS = new Set([5, 10, 15]);
const MAX_VIDEOS_PER_JOB = 8;
const MAX_TITLE_LEN = 200;
const MAX_TRANSCRIPT_LEN = 200_000; // ~30k words — comfortable for a 60-min explainer
/** R2 key shape we mint in /api/channel-clone/r2-upload-url:
 *    channel-clone-uploads/<workspaceId>/<uuid>.<ext>
 *  Validating the shape here (in addition to scoping by workspace
 *  prefix) prevents a malicious caller from supplying a key that
 *  points at another workspace's object even with their own session. */
const R2_KEY_RE = /^channel-clone-uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/i;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const sourceLabel = typeof b.sourceLabel === 'string' ? b.sourceLabel.trim() : '';
  // sourceLabel can be empty — the runner falls back to the first
  // video's title.

  const frameIntervalSec = Number(b.frameIntervalSec ?? 10);
  if (!VALID_FRAME_INTERVALS.has(frameIntervalSec)) {
    return NextResponse.json(
      { error: `frameIntervalSec must be one of ${[...VALID_FRAME_INTERVALS].join(', ')}` },
      { status: 400 },
    );
  }

  if (!Array.isArray(b.videos) || b.videos.length === 0) {
    return NextResponse.json({ error: 'videos must be a non-empty array' }, { status: 400 });
  }
  if (b.videos.length > MAX_VIDEOS_PER_JOB) {
    return NextResponse.json(
      { error: `videos must contain at most ${MAX_VIDEOS_PER_JOB} entries` },
      { status: 400 },
    );
  }

  const videos: UploadedVideoInput[] = [];
  for (const [i, raw] of b.videos.entries()) {
    if (!raw || typeof raw !== 'object') {
      return NextResponse.json({ error: `videos[${i}] is not an object` }, { status: 400 });
    }
    const v = raw as Record<string, unknown>;
    const r2Key = typeof v.r2Key === 'string' ? v.r2Key : '';
    if (!R2_KEY_RE.test(r2Key)) {
      return NextResponse.json(
        { error: `videos[${i}].r2Key must be a channel-clone-uploads R2 key (upload via /api/channel-clone/r2-upload-url first)` },
        { status: 400 },
      );
    }
    // Cross-workspace guard: even with a valid key shape, refuse a
    // key minted in another workspace. The presigned URL would also
    // sign correctly server-side, but we don't want one tenant's
    // session to surface another's objects via the runner.
    const expectedPrefix = `channel-clone-uploads/${session.ws}/`;
    if (!r2Key.startsWith(expectedPrefix)) {
      return NextResponse.json(
        { error: `videos[${i}].r2Key belongs to another workspace` },
        { status: 403 },
      );
    }
    const title = typeof v.title === 'string' ? v.title.trim().slice(0, MAX_TITLE_LEN) : '';
    if (!title) {
      return NextResponse.json({ error: `videos[${i}].title is required` }, { status: 400 });
    }
    const transcript = typeof v.transcript === 'string' ? v.transcript.slice(0, MAX_TRANSCRIPT_LEN) : '';
    videos.push({ r2Key, title, transcript });
  }

  // The "canonical URL" for an upload job is just the synthetic
  // upload:// scheme — there's no real channel URL to canonicalize.
  // The job-store's source_channel_url + source_canonical_url
  // columns store the operator-provided sourceLabel so the recent-
  // runs list has something readable.
  const sourceUrl = sourceLabel || `upload://${new Date().toISOString().slice(0, 10)}`;
  const jobId = await createChannelCloneJob({
    workspaceId: session.ws,
    userId: session.uid,
    sourceChannelUrl: sourceUrl,
    sourceCanonicalUrl: sourceUrl,
  });

  logger.info('[channel-clone intake-upload] kickoff', {
    jobId,
    workspaceId: session.ws,
    videoCount: videos.length,
    frameIntervalSec,
  });

  after(async () => {
    try {
      await runUploadIntake({
        jobId,
        workspaceId: session.ws,
        videos,
        frameIntervalSec: frameIntervalSec as 5 | 10 | 15,
        sourceLabel,
      });
    } catch (err) {
      logger.error('[channel-clone intake-upload] runner crashed', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return NextResponse.json({ jobId }, { status: 202 });
});

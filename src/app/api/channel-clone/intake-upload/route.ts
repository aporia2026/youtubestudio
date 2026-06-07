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
import { validateYoutubeUrl } from '@/lib/channel-clone/validate-youtube-url';
import { getChannelCloneTemplate } from '@/lib/channel-clone/templates-store';

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

  // Plan 2 — load-from-template path. When `fromTemplateId` is set,
  // the route bypasses operator-upload validation and replays the
  // template's stored configuration verbatim against a fresh job.
  // The template-owned R2 keys are workspace-scoped via the SQL row
  // lookup (`getChannelCloneTemplate` filters on workspace_id), so
  // we don't need the R2_KEY_RE shape check that protects the
  // operator-upload path.
  const fromTemplateId = typeof b.fromTemplateId === 'string' ? b.fromTemplateId.trim() : '';
  if (fromTemplateId) {
    return runFromTemplate(session, fromTemplateId);
  }

  const sourceLabel = typeof b.sourceLabel === 'string' ? b.sourceLabel.trim() : '';
  // sourceLabel can be empty — the runner falls back to the first
  // video's title.

  // Optional source channel URL. When provided, validate via the
  // shared YouTube-URL parser so the analyze + publish-pack stages
  // see a canonical form (https://www.youtube.com/@handle or
  // /channel/<id>). Invalid URLs reject early — better than
  // silently dropping the user's input and surprising them later.
  let sourceChannelUrl: string | undefined;
  let sourceChannelHandle: string | null = null;
  if (typeof b.sourceChannelUrl === 'string' && b.sourceChannelUrl.trim().length > 0) {
    const validation = validateYoutubeUrl(b.sourceChannelUrl.trim());
    if (!validation.ok) {
      return NextResponse.json(
        { error: `sourceChannelUrl invalid: ${validation.error}` },
        { status: 400 },
      );
    }
    if (validation.parsed.kind !== 'channel') {
      return NextResponse.json(
        { error: 'sourceChannelUrl must be a channel URL (e.g. youtube.com/@handle), not a video URL' },
        { status: 400 },
      );
    }
    sourceChannelUrl = validation.parsed.canonical;
    sourceChannelHandle = validation.parsed.identifierType === 'handle' ? validation.parsed.identifier : null;
  }

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

  // The "canonical URL" for an upload job uses the real channel
  // URL when the operator supplied one (so recent-runs / analyze /
  // publish-pack see something they can reason about); otherwise
  // falls back to the operator-provided sourceLabel; otherwise to
  // a dated synthetic marker.
  const sourceUrlForRow = sourceChannelUrl
    ?? (sourceLabel || `upload://${new Date().toISOString().slice(0, 10)}`);
  const jobId = await createChannelCloneJob({
    workspaceId: session.ws,
    userId: session.uid,
    sourceChannelUrl: sourceUrlForRow,
    sourceCanonicalUrl: sourceUrlForRow,
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
        sourceChannelUrl,
        sourceChannelHandle,
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

/** Load-from-template execution path. Resolves the template, builds
 *  the same `UploadedVideoInput[]` shape the operator-upload path
 *  produces, and kicks off the runner. The runner happily curls any
 *  R2 key it's handed via presigned URL — no re-upload needed. */
async function runFromTemplate(
  session: { ws: string; uid: string },
  templateId: string,
): Promise<NextResponse> {
  const template = await getChannelCloneTemplate(templateId, session.ws);
  if (!template) {
    return NextResponse.json({ error: 'template not found' }, { status: 404 });
  }
  const cfg = template.config_jsonb;
  if (cfg.videos.length === 0) {
    return NextResponse.json({ error: 'template has no videos' }, { status: 409 });
  }
  const videos: UploadedVideoInput[] = cfg.videos.map((v) => ({
    r2Key: v.r2Key,
    title: v.title,
    transcript: v.transcript,
  }));
  const sourceUrlForRow = cfg.sourceChannelUrl
    ?? (cfg.sourceChannelName ? `template://${template.id}` : `upload://${new Date().toISOString().slice(0, 10)}`);
  const jobId = await createChannelCloneJob({
    workspaceId: session.ws,
    userId: session.uid,
    sourceChannelUrl: sourceUrlForRow,
    sourceCanonicalUrl: sourceUrlForRow,
  });
  logger.info('[channel-clone intake-upload] kickoff from template', {
    jobId, templateId, videoCount: videos.length, sourceChannelName: cfg.sourceChannelName,
  });
  after(async () => {
    try {
      await runUploadIntake({
        jobId,
        workspaceId: session.ws,
        videos,
        frameIntervalSec: cfg.frameIntervalSec,
        sourceLabel: cfg.sourceChannelName ?? '',
        sourceChannelUrl: cfg.sourceChannelUrl ?? undefined,
        sourceChannelHandle: cfg.sourceChannelHandle ?? null,
      });
    } catch (err) {
      logger.error('[channel-clone intake-upload] runner crashed (from template)', {
        jobId, templateId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return NextResponse.json({ jobId, fromTemplateId: templateId }, { status: 202 });
}

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
import { getChannelCloneJob, mergeChannelCloneJobState } from '@/lib/channel-clone/job-store';
import { buildStagingKeyForJob } from '@/lib/channel-clone/intake-upload-runner';
import { checkR2KeysExist, inferExtensionFromKey } from '@/lib/channel-clone/templates-r2';
import type { CleanedTranscript } from '@/lib/channel-clone/types';

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

/** Staging-prefix R2 key shape — written by intake-upload-runner at
 *  the end of every successful upload-intake run. Used by the "pick
 *  from previous uploads" flow so the operator can reuse individual
 *  videos from prior runs without re-uploading. Format:
 *    channel-clone-uploads-staging/<workspaceId>/<jobId>/<NNN>.<ext>
 *  Workspace ownership is enforced via the prefix segment (matched
 *  against session.ws below). 2026-06-08. */
const R2_STAGING_KEY_RE = /^channel-clone-uploads-staging\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d{3}\.[a-z0-9]{2,5}$/i;

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

  // 2026-06-08 — "reuse a previous run's inputs" path. Distinct from
  // fromTemplateId: a template is an EXPLICITLY saved snapshot;
  // fromJobId here is "any previous job whose staging assets are
  // still alive in the 7-day window." Same workspace-scoped guards
  // as fromTemplateId via `getChannelCloneJob`.
  const fromJobId = typeof b.fromJobId === 'string' ? b.fromJobId.trim() : '';
  if (fromJobId) {
    return runFromPreviousJob(session, fromJobId);
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
    const isFreshUpload = R2_KEY_RE.test(r2Key);
    const isStagingReuse = R2_STAGING_KEY_RE.test(r2Key);
    if (!isFreshUpload && !isStagingReuse) {
      return NextResponse.json(
        { error: `videos[${i}].r2Key must be a channel-clone-uploads or channel-clone-uploads-staging R2 key` },
        { status: 400 },
      );
    }
    // Cross-workspace guard: even with a valid key shape, refuse a
    // key minted in another workspace. The presigned URL would also
    // sign correctly server-side, but we don't want one tenant's
    // session to surface another's objects via the runner.
    const expectedPrefix = isStagingReuse
      ? `channel-clone-uploads-staging/${session.ws}/`
      : `channel-clone-uploads/${session.ws}/`;
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
  // If the template carries a previously-cloned ElevenLabs voice id,
  // inherit it onto the new job so the operator doesn't have to re-
  // clone the same voice. Voice still has to live in the operator's
  // ElevenLabs account — if they deleted it there, the inherited
  // voice id surfaces as dangling when they try to use it (which is
  // the same fail mode as any stale voice id). Plan 1 ↔ 2 integration.
  if (cfg.clonedVoiceId) {
    try {
      await mergeChannelCloneJobState(jobId, session.ws, {
        clonedVoice: {
          voiceId: cfg.clonedVoiceId,
          name: cfg.sourceChannelName ? `(from template) ${cfg.sourceChannelName}` : '(from template)',
          subscriptionTier: 'inherited',
          clonedAt: new Date().toISOString(),
          clonedBy: session.uid,
        },
      });
      logger.info('[channel-clone intake-upload] inherited cloned voice from template', {
        jobId, templateId, voiceId: cfg.clonedVoiceId,
      });
    } catch (err) {
      // Best-effort — the run still works even if persisting the
      // inherited voice id fails; the operator can press Clone in
      // the panel for a fresh voice.
      logger.warn('[channel-clone intake-upload] could not inherit cloned voice from template', {
        jobId, templateId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('[channel-clone intake-upload] kickoff from template', {
    jobId, templateId, videoCount: videos.length, sourceChannelName: cfg.sourceChannelName,
    inheritedVoiceId: cfg.clonedVoiceId ?? null,
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

/** Reuse the videos + transcripts from a previous run (no Save-as-
 *  template required). Looks at the per-job staging prefix
 *  channel-clone-uploads-staging/<wsId>/<oldJobId>/<i>.<ext> populated
 *  by intake-upload-runner. The prefix has a 7-day R2 lifecycle, so
 *  we HEAD-probe each key first and bail with a clear message if too
 *  many have expired. Transcripts are reconstructed from the saved
 *  `state_jsonb.intake.sampleVideos[].transcript` (lines.join('\n')). */
async function runFromPreviousJob(
  session: { ws: string; uid: string },
  fromJobId: string,
): Promise<NextResponse> {
  const oldJob = await getChannelCloneJob(fromJobId, session.ws);
  if (!oldJob) {
    return NextResponse.json({ error: 'previous run not found' }, { status: 404 });
  }
  const intake = oldJob.state_jsonb.intake;
  if (!intake) {
    return NextResponse.json(
      { error: 'Previous run has no completed intake to reuse — there are no video files yet.' },
      { status: 409 },
    );
  }
  // Only upload-intake runs persist video bytes to a recoverable
  // prefix. URL-intake runs stream through a sandbox and discard the
  // bytes at end of intake — nothing to reuse.
  const isUploadJob = intake.sampleVideos.every((v) => v.videoUrl.startsWith('r2://'));
  if (!isUploadJob) {
    return NextResponse.json(
      { error: 'Only upload-intake runs can be reused. URL-intake (yt-dlp) runs don\'t retain video bytes after intake.' },
      { status: 409 },
    );
  }

  // Reconstruct the staging keys. Same deterministic format the
  // runner used at intake-end. Walk in the same order the videos
  // were processed.
  const stagingKeys: string[] = intake.sampleVideos.map((v, i) => {
    const origKey = extractOriginalKeyFromVideoUrl(v.videoUrl);
    const ext = inferExtensionFromKey(origKey) ?? 'mp4';
    return buildStagingKeyForJob(session.ws, fromJobId, i, ext);
  });

  // HEAD-probe every staging key. R2's 7-day lifecycle rule may
  // have reaped some — surface a clean error rather than letting
  // curl fail mid-sandbox.
  const existence = await checkR2KeysExist(stagingKeys);
  const missingCount = existence.filter((e) => !e.exists).length;
  if (missingCount === stagingKeys.length) {
    return NextResponse.json(
      {
        error: 'The video files from that run have expired from the 7-day staging window. Re-upload manually, or next time press "Save as template" while a run is fresh to keep videos around permanently.',
      },
      { status: 409 },
    );
  }
  if (missingCount > 0) {
    return NextResponse.json(
      {
        error: `${missingCount} of ${stagingKeys.length} videos from that run have expired (7-day staging window). The run is partly reusable but we don't auto-pick a subset — re-upload the missing ones manually, or save the next run as a template to avoid this.`,
      },
      { status: 409 },
    );
  }

  const videos: UploadedVideoInput[] = intake.sampleVideos.map((v, i) => ({
    r2Key: stagingKeys[i],
    title: v.title,
    transcript: linesToText(v.transcript),
  }));

  // Source URL on the new job. If the original carried a real
  // channel URL, keep it; otherwise carry forward the `upload://`
  // marker so analyze + publish-pack stages reason about it the
  // same way the old run did.
  const sourceUrlForRow = intake.sourceChannelUrl
    || (intake.sourceChannelName ? `reuseOf://${fromJobId}` : `upload://${new Date().toISOString().slice(0, 10)}`);

  const jobId = await createChannelCloneJob({
    workspaceId: session.ws,
    userId: session.uid,
    sourceChannelUrl: sourceUrlForRow,
    sourceCanonicalUrl: sourceUrlForRow,
  });

  // If the source job had a cloned ElevenLabs voice id, inherit it
  // (same shape as the fromTemplateId path).
  const inheritedVoiceId = oldJob.state_jsonb.clonedVoice?.voiceId;
  if (inheritedVoiceId) {
    try {
      await mergeChannelCloneJobState(jobId, session.ws, {
        clonedVoice: {
          voiceId: inheritedVoiceId,
          name: intake.sourceChannelName
            ? `(reused) ${intake.sourceChannelName}`
            : '(reused)',
          subscriptionTier: 'inherited',
          clonedAt: new Date().toISOString(),
          clonedBy: session.uid,
        },
      });
    } catch (err) {
      logger.warn('[channel-clone intake-upload] could not inherit cloned voice (reuseOf)', {
        jobId, fromJobId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('[channel-clone intake-upload] kickoff reusing previous job', {
    jobId, fromJobId, videoCount: videos.length, hadVoiceInheritance: Boolean(inheritedVoiceId),
  });
  after(async () => {
    try {
      await runUploadIntake({
        jobId,
        workspaceId: session.ws,
        videos,
        // Original intake's frameIntervalSec isn't persisted on
        // state — default to 10 which is the form's default too.
        frameIntervalSec: 10,
        sourceLabel: intake.sourceChannelName ?? '',
        sourceChannelUrl: intake.sourceChannelUrl?.startsWith('http')
          ? intake.sourceChannelUrl
          : undefined,
        sourceChannelHandle: intake.sourceChannelHandle ?? null,
      });
    } catch (err) {
      logger.error('[channel-clone intake-upload] runner crashed (from previous job)', {
        jobId, fromJobId, error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return NextResponse.json({ jobId, fromJobId }, { status: 202 });
}

/** Extract the original R2 key out of `r2://bucket/key` URLs that
 *  `intake-upload-runner` stamps onto `intake.sampleVideos[].videoUrl`. */
function extractOriginalKeyFromVideoUrl(videoUrl: string): string {
  const m = /^r2:\/\/[^/]+\/(.+)$/.exec(videoUrl);
  return m ? m[1] : videoUrl;
}

/** Reconstruct the raw transcript text from the parsed
 *  CleanedTranscript that the intake stage persisted. Drops SRT
 *  timecodes (the upload-intake parser re-derives them from the SRT
 *  pattern; plain text mode is fine for reuse). */
function linesToText(transcript: CleanedTranscript | null | undefined): string {
  if (!transcript) return '';
  return transcript.lines.map((l) => l.text).join('\n').trim();
}

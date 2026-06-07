/**
 * GET  /api/channel-clone/templates
 * POST /api/channel-clone/templates
 *
 * Plan 2: _plans/2026-06-07-channel-clone-preset-templates.md.
 *
 * GET — workspace's live templates, most-recent first. Used by the
 *       Use-template dropdown + the dedicated Templates page.
 *
 * POST — Save a successful (or failed) channel-clone job's
 *        configuration AS A TEMPLATE. Copies the operator's uploaded
 *        reference videos from the per-job staging prefix into the
 *        template-owned prefix so the template survives deletion of
 *        the source job.
 *
 *        Body: { jobId: string, name: string, replaceExisting?: boolean }
 *
 *        On name collision the route returns 409 with a `replace:true`
 *        hint; the client re-POSTs with `replaceExisting=true` to
 *        confirm.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';
import {
  countChannelCloneTemplates,
  createChannelCloneTemplate,
  findChannelCloneTemplateByName,
  listChannelCloneTemplates,
  softDeleteChannelCloneTemplate,
  type ChannelCloneTemplateConfig,
} from '@/lib/channel-clone/templates-store';
import {
  copyR2KeysToPrefix,
  deleteTemplateR2Keys,
  inferExtensionFromKey,
} from '@/lib/channel-clone/templates-r2';
import { buildStagingKeyForJob } from '@/lib/channel-clone/intake-upload-runner';

export const maxDuration = 60;

/** Soft cap on templates per workspace. Surface a clear "delete one
 *  to save a new one" error rather than letting R2 silently bloat. */
const MAX_TEMPLATES_PER_WORKSPACE = 50;

export const GET = apiRoute.authed(async (session) => {
  const templates = await listChannelCloneTemplates(session.ws);
  // Trim heavy fields off the list response — the dropdown only
  // needs the surface metadata, not the full config_jsonb. The
  // detail endpoint returns everything when the operator selects
  // a template.
  return NextResponse.json({
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      bytes: t.bytes,
      videoCount: t.config_jsonb.videos.length,
      sourceChannelName: t.config_jsonb.sourceChannelName,
      createdAt: t.created_at,
    })),
  });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const o = (body ?? {}) as Record<string, unknown>;
  const jobId = typeof o.jobId === 'string' ? o.jobId.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const replaceExisting = o.replaceExisting === true;
  if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: 'name must be 80 characters or fewer' }, { status: 400 });

  // 1. Resolve the job + verify it's an upload-intake job (URL intake
  //    can't be saved as a template today; the source videos came
  //    from yt-dlp and were never copied to a staging prefix).
  const job = await getChannelCloneJob(jobId, session.ws);
  if (!job) return NextResponse.json({ error: 'job not found' }, { status: 404 });
  const intake = job.state_jsonb.intake;
  if (!intake) {
    return NextResponse.json(
      { error: 'Job has no completed intake; cannot save as template yet.' },
      { status: 409 },
    );
  }
  const isUploadIntake = intake.sourceChannelUrl.startsWith('upload://')
    || intake.sampleVideos.every((v) => v.videoUrl.startsWith('r2://'));
  if (!isUploadIntake) {
    return NextResponse.json(
      { error: 'Templates can only be saved from upload-intake jobs (the URL-intake path streams videos through a sandbox without keeping copies). Re-run via upload to create a template.' },
      { status: 409 },
    );
  }

  // 2. Workspace cap.
  const count = await countChannelCloneTemplates(session.ws);
  if (count >= MAX_TEMPLATES_PER_WORKSPACE) {
    return NextResponse.json(
      { error: `Template cap of ${MAX_TEMPLATES_PER_WORKSPACE} reached for this workspace. Delete one to save a new one.` },
      { status: 409 },
    );
  }

  // 3. Name collision handling.
  const existing = await findChannelCloneTemplateByName(session.ws, name);
  if (existing && !replaceExisting) {
    return NextResponse.json(
      { error: `Template "${name}" already exists. Re-submit with replaceExisting=true to overwrite.`, replace: true, existingTemplateId: existing.id },
      { status: 409 },
    );
  }

  // 4. Reconstruct the staging keys from the job's intake.sampleVideos.
  //    Each sampleVideo's videoUrl is `r2://${bucket}/${original_key}`.
  //    The runner copied the original_key into the staging prefix at
  //    end of intake (see intake-upload-runner.ts). Same naming
  //    convention; we reconstruct using `buildStagingKeyForJob`.
  const stagingKeys: string[] = [];
  for (const [i, v] of intake.sampleVideos.entries()) {
    const original = extractOriginalKeyFromVideoUrl(v.videoUrl);
    const ext = inferExtensionFromKey(original) ?? 'mp4';
    stagingKeys.push(buildStagingKeyForJob(session.ws, jobId, i, ext));
  }

  // 5. Copy from staging → real template prefix. We INSERT first
  //    with empty r2_keys, then UPDATE after the copy to keep the
  //    one round trip — actually no, copy first, INSERT once with
  //    final values. If the copy partially fails we surface a 500.
  //    On total failure no template row exists.
  const tempIdHint = `pending-${Date.now()}`;
  const destPrefix = `channel-clone-templates/${session.ws}/${tempIdHint}`;
  let copyResult;
  try {
    copyResult = await copyR2KeysToPrefix({ sourceKeys: stagingKeys, destPrefix });
  } catch (err) {
    logger.error('[channel-clone templates POST] r2 copy threw', {
      jobId, error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Could not copy reference videos into the template store. They may have expired from the 7-day staging window; re-run intake to refresh.' },
      { status: 500 },
    );
  }
  if (copyResult.copiedKeys.length === 0) {
    return NextResponse.json(
      { error: 'No reference videos could be copied into the template. They may have expired from the 7-day staging window; re-run intake to refresh.' },
      { status: 409 },
    );
  }
  if (copyResult.failedIndices.length > 0) {
    // Roll back the successful copies so we don't leave a partial
    // template-prefix worth of orphan objects.
    await deleteTemplateR2Keys(copyResult.copiedKeys.map((c) => c.destKey));
    return NextResponse.json(
      { error: `Some videos could not be copied (${copyResult.failedIndices.length}/${stagingKeys.length}). Re-run intake and try saving again.` },
      { status: 500 },
    );
  }

  const totalBytes = copyResult.copiedKeys.reduce((acc, c) => acc + c.bytes, 0);

  // 6. Build config_jsonb pointing at the new template-owned keys.
  const config: ChannelCloneTemplateConfig = {
    sourceChannelUrl: intake.sourceChannelUrl,
    sourceChannelHandle: intake.sourceChannelHandle,
    sourceChannelName: intake.sourceChannelName,
    // Frame interval isn't stored on the job state today; pick a
    // reasonable default of 10 so the loaded template matches the
    // original-intake settings most operators ran with.
    frameIntervalSec: 10,
    videos: intake.sampleVideos.map((v, i) => ({
      r2Key: copyResult.copiedKeys[i].destKey,
      title: v.title,
      transcript: linesToText(v.transcript),
    })),
    // Include the cloned voice id if the operator already cloned —
    // the load flow surfaces this as a pre-filled voice_id but never
    // re-clones automatically.
    clonedVoiceId: job.state_jsonb.clonedVoice?.voiceId,
  };

  // 7. Replace existing if asked; INSERT the new row.
  if (existing && replaceExisting) {
    try {
      // Soft-delete the existing row + clean its R2 manifest. We don't
      // re-use the existing prefix path because the unique index is on
      // (workspace, lower(name)) with deleted_at filter — the new row
      // can carry the same name once the old one is flagged deleted.
      await softDeleteChannelCloneTemplate(existing.id, session.ws);
      await deleteTemplateR2Keys(existing.r2_keys);
    } catch (err) {
      logger.warn('[channel-clone templates POST] replace cleanup failed', {
        existingId: existing.id, error: err instanceof Error ? err.message : String(err),
      });
      // Press on — the unique index on lower(name) WHERE deleted_at
      // IS NULL will reject the INSERT below if the soft-delete
      // failed.
    }
  }

  try {
    const { templateId } = await createChannelCloneTemplate({
      workspaceId: session.ws,
      userId: session.uid,
      name,
      config,
      r2Keys: copyResult.copiedKeys.map((c) => c.destKey),
      bytes: totalBytes,
    });
    logger.info('[channel-clone templates POST] done', {
      templateId, jobId, name, videoCount: config.videos.length, bytes: totalBytes,
    });
    return NextResponse.json({
      ok: true,
      template: {
        id: templateId,
        name,
        bytes: totalBytes,
        videoCount: config.videos.length,
      },
    });
  } catch (err) {
    // Roll back R2 to avoid orphans on insert failure.
    logger.error('[channel-clone templates POST] insert failed; rolling back R2', {
      error: err instanceof Error ? err.message : String(err),
    });
    await deleteTemplateR2Keys(copyResult.copiedKeys.map((c) => c.destKey));
    return NextResponse.json(
      { error: 'Could not save template metadata. Please retry.' },
      { status: 500 },
    );
  }
});

/** Extract the original R2 key out of a `r2://bucket/key` URL.
 *  Falls back to the raw input when the URL prefix is missing. */
function extractOriginalKeyFromVideoUrl(videoUrl: string): string {
  const m = /^r2:\/\/[^/]+\/(.+)$/.exec(videoUrl);
  return m ? m[1] : videoUrl;
}

function linesToText(transcript: { lines: { text: string }[] } | null | undefined): string {
  if (!transcript) return '';
  return transcript.lines.map((l) => l.text).join('\n').trim();
}

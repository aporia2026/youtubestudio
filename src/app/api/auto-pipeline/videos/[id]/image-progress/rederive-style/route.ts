/**
 * POST /api/auto-pipeline/videos/[id]/image-progress/rederive-style
 *
 * Body:
 *   {
 *     model?: string,           // kie-gemini-* id; default kie-gemini-3-5-flash
 *     regenerate?: 'failed' | 'all',  // default 'failed'
 *   }
 *
 * Re-runs vision-based style derivation against the channel-clone
 * job's intake frames, persists the new ai_image_suffix + ref pool
 * onto the doc's channel_style_override, and clears matching rows'
 * image_url + retry state so the next cron tick regenerates them
 * with the new style.
 *
 * The channel-clone job id is read off the artefact's
 * metadata.channel_clone.job_id field. When that's missing the route
 * 409s — only channel-clone-spawned videos have intake frames to
 * derive style from.
 *
 * Workspace-scoped. 2026-06-08.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getChannelCloneJob } from '@/lib/channel-clone/job-store';
import { rederiveChannelStyleFromFrames } from '@/lib/auto-pipeline/rederive-channel-style';

export const maxDuration = 90;

const DEFAULT_VISION_MODEL = 'kie-gemini-3-5-flash';

export const POST = apiRoute.authed<{ id: string }>(async (session, req: NextRequest, ctx) => {
  const { id: videoId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const modelId = typeof b.model === 'string' && b.model.trim().length > 0
    ? b.model.trim()
    : DEFAULT_VISION_MODEL;
  if (!modelId.startsWith('kie-gemini')) {
    return NextResponse.json(
      { error: 'model must be a kie-gemini-* id (the only family that supports our multimodal image input today).' },
      { status: 400 },
    );
  }
  const regenerate = b.regenerate === 'all' ? 'all' : 'failed';

  // Resolve the latest production_doc artefact + its channel-clone
  // back-pointer.
  const { rows: artefactRows } = await sql.query<{
    attempt_number: number;
    metadata_jsonb: Record<string, unknown> | null;
  }>(
    `
    SELECT psa.attempt_number, psa.metadata_jsonb
      FROM pipeline_stage_artefacts psa
      JOIN pipeline_run_videos prv ON prv.id = psa.pipeline_run_video_id
     WHERE psa.pipeline_run_video_id = $1::uuid
       AND prv.workspace_id = $2::uuid
       AND psa.stage = 'generating_production_doc'
       AND psa.artefact_kind = 'production_doc'
     ORDER BY psa.attempt_number DESC
     LIMIT 1
    `,
    [videoId, session.ws],
  );
  if (artefactRows.length === 0 || !artefactRows[0].metadata_jsonb) {
    return NextResponse.json({ error: 'no production_doc artefact for this video' }, { status: 404 });
  }
  const attemptNumber = artefactRows[0].attempt_number;
  const metadata = artefactRows[0].metadata_jsonb as Record<string, unknown>;
  const channelClone = metadata.channel_clone as { job_id?: string } | undefined;
  const channelCloneJobId = channelClone?.job_id;
  if (!channelCloneJobId) {
    return NextResponse.json(
      { error: 'This video was not produced by channel-clone; rederive-style only works on channel-clone-spawned docs.' },
      { status: 409 },
    );
  }

  const job = await getChannelCloneJob(channelCloneJobId, session.ws);
  if (!job) {
    return NextResponse.json(
      { error: 'The originating channel-clone job is no longer reachable (deleted or cross-workspace).' },
      { status: 404 },
    );
  }
  const intake = job.state_jsonb.intake;
  if (!intake) {
    return NextResponse.json(
      { error: 'The channel-clone job has no completed intake to derive style from.' },
      { status: 409 },
    );
  }

  let derived;
  try {
    derived = await rederiveChannelStyleFromFrames({ intake, modelId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[rederive-style] failed', { videoId, modelId, error: message });
    return NextResponse.json(
      { error: `Style rederivation failed: ${message}` },
      { status: 502 },
    );
  }

  // Patch the doc's channel_style_override + reset matching rows.
  const doc = metadata.doc as { rows?: Record<string, unknown>[]; channel_style_override?: unknown } | undefined;
  if (!doc || !Array.isArray(doc.rows)) {
    return NextResponse.json({ error: 'artefact has no doc.rows' }, { status: 500 });
  }
  doc.channel_style_override = {
    ai_image_suffix: derived.aiImageSuffix,
    ref_r2_keys: derived.refR2Keys,
    reason: derived.reason,
  };

  let rowsResetCount = 0;
  for (const row of doc.rows) {
    const r = row as Record<string, unknown>;
    const hasError = !!r.last_error;
    const hasUrl = typeof r.image_url === 'string' && (r.image_url as string).trim().length > 0;
    const shouldReset = regenerate === 'all' ? (hasUrl || hasError) : hasError || !hasUrl;
    if (shouldReset) {
      delete r.image_url;
      delete r.mouth_removed_url;
      delete r.motion_collage_image_url;
      delete r.motion_collage_panel_urls;
      delete r.attempts;
      delete r.last_error;
      rowsResetCount += 1;
    }
  }

  await sql.query(
    `
    UPDATE pipeline_stage_artefacts
       SET metadata_jsonb = $1::jsonb
     WHERE pipeline_run_video_id = $2::uuid
       AND stage = 'generating_production_doc'
       AND attempt_number = $3
       AND artefact_kind = 'production_doc'
    `,
    [JSON.stringify(metadata), videoId, attemptNumber],
  );

  // Bump terminally failed back to active.
  const { rows: stageRows } = await sql.query<{ stage: string }>(
    `SELECT stage FROM pipeline_run_videos WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [videoId, session.ws],
  );
  if (stageRows.length > 0 && stageRows[0].stage === 'production_doc_images_failed') {
    await sql.query(
      `
      UPDATE pipeline_run_videos
         SET stage = 'generating_production_doc_images',
             failure_class = NULL,
             failure_message = NULL,
             claimed_at = NULL,
             claimed_by_tick = NULL,
             updated_at = NOW()
       WHERE id = $1::uuid AND workspace_id = $2::uuid
      `,
      [videoId, session.ws],
    );
  }

  // Also persist the new channel-style suffix + ref pool back to the
  // channel-clone job state. Future runs that re-handoff from this
  // job will pick up the improved derivation automatically rather
  // than re-running the generic deriveChannelStyle.
  try {
    const currentChannelStyle = job.state_jsonb.channelStyle ?? {};
    await sql.query(
      `
      UPDATE channel_clone_jobs
         SET state_jsonb = jsonb_set(
               state_jsonb,
               '{channelStyle}',
               $1::jsonb,
               true
             )
       WHERE id = $2::uuid AND workspace_id = $3::uuid
      `,
      [
        JSON.stringify({
          ...currentChannelStyle,
          aiImageSuffix: derived.aiImageSuffix,
          refR2Keys: derived.refR2Keys,
          reason: derived.reason,
          derivedAt: new Date().toISOString(),
        }),
        channelCloneJobId,
        session.ws,
      ],
    );
  } catch (err) {
    // Non-fatal — the artefact is the source of truth for THIS run.
    logger.warn('[rederive-style] could not persist back to channel-clone job; artefact still updated', {
      channelCloneJobId, error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('[rederive-style] applied', {
    videoId, channelCloneJobId,
    model: modelId, regenerate, rows_reset: rowsResetCount,
    suffix_preview: derived.aiImageSuffix.slice(0, 200),
  });

  return NextResponse.json({
    ok: true,
    rows_reset: rowsResetCount,
    ai_image_suffix: derived.aiImageSuffix,
    ref_pool_size: derived.refR2Keys.length,
    reason: derived.reason,
  });
});

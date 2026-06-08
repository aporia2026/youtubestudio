/**
 * POST /api/auto-pipeline/videos/[id]/image-progress/change-model
 *
 * Body:
 *   {
 *     scope: 'doc' | 'row',
 *     model: string | null,         // null = clear the override
 *     row_index?: number,           // required when scope === 'row'
 *     regenerate?: 'failed' | 'all' // optional; on 'doc' scope: clear
 *                                   //   image_url + last_error so the
 *                                   //   next tick re-generates with the
 *                                   //   new model. 'failed' clears only
 *                                   //   the failed rows; 'all' clears
 *                                   //   every row. Default: leave
 *                                   //   existing images alone (the
 *                                   //   model only applies to unfilled
 *                                   //   rows).
 *   }
 *
 * Writes the override(s) onto the production_doc artefact's
 * metadata_jsonb. Resets any failed-row state so the next cron tick
 * re-picks the affected rows with the new model.
 *
 * Workspace-scoped via the FK chain (pipeline_run_videos ->
 * workspace_id). 404 on cross-workspace ids.
 *
 * 2026-06-08 — closes the "image model picker for all stages"
 * request.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getI2IModelSpec } from '@/lib/image-models-i2i';

export const POST = apiRoute.authed<{ id: string }>(async (session, req: NextRequest, ctx) => {
  const { id: videoId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const scope = b.scope;
  if (scope !== 'doc' && scope !== 'row') {
    return NextResponse.json({ error: 'scope must be "doc" or "row"' }, { status: 400 });
  }
  // model: a registry-validated string, OR null (clear the override).
  let modelValue: string | null = null;
  if (b.model === null) {
    modelValue = null;
  } else if (typeof b.model === 'string') {
    const trimmed = b.model.trim();
    if (trimmed.length === 0) {
      modelValue = null;
    } else {
      const spec = getI2IModelSpec(trimmed);
      if (!spec) {
        return NextResponse.json(
          { error: `unknown model "${trimmed}". See /image-progress for the available list.` },
          { status: 400 },
        );
      }
      if (spec.provider === 'comfyui-local') {
        return NextResponse.json(
          { error: `model "${trimmed}" is local-only and cannot run in the auto-pipeline.` },
          { status: 400 },
        );
      }
      modelValue = trimmed;
    }
  } else {
    return NextResponse.json({ error: 'model must be a string or null' }, { status: 400 });
  }
  const rowIndex = scope === 'row' ? Number(b.row_index) : -1;
  if (scope === 'row' && (!Number.isInteger(rowIndex) || rowIndex < 0)) {
    return NextResponse.json(
      { error: 'row_index is required for scope="row" and must be a non-negative integer' },
      { status: 400 },
    );
  }
  const regenerate = b.regenerate;
  if (regenerate !== undefined && regenerate !== 'failed' && regenerate !== 'all') {
    return NextResponse.json(
      { error: 'regenerate must be "failed", "all", or omitted' },
      { status: 400 },
    );
  }

  // Resolve the latest artefact.
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
  const doc = metadata.doc as { rows?: Record<string, unknown>[]; image_model_override?: string } | undefined;
  const docRows = doc?.rows;
  if (!doc || !Array.isArray(docRows)) {
    return NextResponse.json({ error: 'artefact has no rows array' }, { status: 500 });
  }

  // Apply the override.
  let rowsResetCount = 0;
  if (scope === 'doc') {
    if (modelValue === null) {
      delete doc.image_model_override;
    } else {
      doc.image_model_override = modelValue;
    }
    // Doc-level regeneration: clear image_url + retry state on
    // matching rows. The next cron tick re-generates them with the
    // new model.
    if (regenerate === 'failed' || regenerate === 'all') {
      for (const row of docRows) {
        const r = row as Record<string, unknown>;
        const hasError = !!r.last_error;
        const hasUrl = typeof r.image_url === 'string' && (r.image_url as string).trim().length > 0;
        const shouldReset = regenerate === 'all' ? (hasUrl || hasError) : hasError;
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
    }
  } else {
    if (rowIndex >= docRows.length) {
      return NextResponse.json(
        { error: `row_index ${rowIndex} out of range (doc has ${docRows.length} rows)` },
        { status: 400 },
      );
    }
    const target = docRows[rowIndex] as Record<string, unknown>;
    if (modelValue === null) {
      delete target.image_model_override;
    } else {
      target.image_model_override = modelValue;
    }
    // Always reset the target row so the next tick re-generates it
    // with the new model. The whole point of changing the per-row
    // model is to redo that row.
    delete target.image_url;
    delete target.mouth_removed_url;
    delete target.motion_collage_image_url;
    delete target.motion_collage_panel_urls;
    delete target.attempts;
    delete target.last_error;
    rowsResetCount = 1;
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

  // When the video terminally failed in image-gen, flip it back to
  // the active stage so the next cron tick picks it up. Otherwise
  // the artefact updates would sit there with no cron attention.
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

  logger.info('auto-pipeline: image model override applied', {
    pipeline_video_id: videoId,
    workspace_id: session.ws,
    scope,
    model: modelValue,
    row_index: scope === 'row' ? rowIndex : null,
    regenerate: regenerate ?? null,
    rows_reset: rowsResetCount,
  });

  return NextResponse.json({
    ok: true,
    rows_reset: rowsResetCount,
  });
});

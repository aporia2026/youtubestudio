/**
 * POST /api/auto-pipeline/videos/[id]/image-progress/retry-row
 *
 * Body: { row_index: number }
 *
 * Clears `attempts` + `last_error` on one row of the production_doc
 * artefact so the next cron tick picks it back into the plan. This
 * is the fix for "exhausted" rows that hit their retry budget --
 * without this, the operator has no way to retry a single bad row
 * short of rerunning the whole stage.
 *
 * Composite-PK targeted UPDATE on the latest artefact attempt.
 * Workspace-scoped via the same FK chain (pipeline_run_videos ->
 * workspace_id). 404 on cross-workspace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

export const POST = apiRoute.authed<{ id: string }>(async (session, req: NextRequest, ctx) => {
  const { id: videoId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const rowIndex = Number(b.row_index);
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    return NextResponse.json({ error: 'row_index must be a non-negative integer' }, { status: 400 });
  }

  // Pull the latest artefact (composite PK; freshest attempt).
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
  const doc = metadata.doc as { rows?: Record<string, unknown>[] } | undefined;
  const docRows = doc?.rows;
  if (!Array.isArray(docRows)) {
    return NextResponse.json({ error: 'artefact has no rows array' }, { status: 500 });
  }
  if (rowIndex >= docRows.length) {
    return NextResponse.json(
      { error: `row_index ${rowIndex} out of range (doc has ${docRows.length} rows)` },
      { status: 400 },
    );
  }

  // Clear the row's failure state. Leave image_url alone -- if it
  // somehow got partially set, the next tick's plan-build will skip
  // the row (image_url present = done). Operators who want to FORCE
  // a re-generation of an already-done row need a different action;
  // this endpoint is only for unsticking failed rows.
  const targetRow = docRows[rowIndex] as Record<string, unknown>;
  delete targetRow.attempts;
  delete targetRow.last_error;

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

  // Make sure the row is in an image-gen-able stage so the cron will
  // see it. If the video terminally failed (production_doc_images_failed),
  // bump it back to the active stage so the next tick claims it.
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

  logger.info('auto-pipeline: image-progress row retry', {
    pipeline_video_id: videoId,
    workspace_id: session.ws,
    row_index: rowIndex,
  });

  return NextResponse.json({ ok: true });
});

/**
 * POST /api/auto-pipeline/videos/[id]/image-progress/edit-row
 *
 * Body:
 *   {
 *     row_index: number,
 *     prompt?: string,                // new ai_image_prompt
 *     image_model_override?: string | null,  // null clears
 *     regenerate?: boolean,           // default true when prompt
 *                                     // changes; clears image_url +
 *                                     // retry state so the next tick
 *                                     // regenerates the row.
 *   }
 *
 * Per-row edit + (optional) force-regenerate. Distinct from
 * change-model so the operator can edit the prompt WITHOUT necessarily
 * changing the model, and regenerate a DONE row without nuking the
 * rest of the doc.
 *
 * Workspace-scoped. 2026-06-08.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getI2IModelSpec } from '@/lib/image-models-i2i';

const MAX_PROMPT_LEN = 1500;

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
  let newPrompt: string | undefined;
  if (b.prompt !== undefined) {
    if (typeof b.prompt !== 'string') {
      return NextResponse.json({ error: 'prompt must be a string' }, { status: 400 });
    }
    const trimmed = b.prompt.trim();
    if (trimmed.length === 0) {
      return NextResponse.json({ error: 'prompt cannot be empty' }, { status: 400 });
    }
    if (trimmed.length > MAX_PROMPT_LEN) {
      return NextResponse.json(
        { error: `prompt cannot exceed ${MAX_PROMPT_LEN} characters` },
        { status: 400 },
      );
    }
    newPrompt = trimmed;
  }
  let newModel: string | null | undefined;
  if (b.image_model_override === null) {
    newModel = null;
  } else if (typeof b.image_model_override === 'string') {
    const trimmed = b.image_model_override.trim();
    if (trimmed.length === 0) {
      newModel = null;
    } else {
      const spec = getI2IModelSpec(trimmed);
      if (!spec || spec.provider === 'comfyui-local') {
        return NextResponse.json(
          { error: `model "${trimmed}" is unknown or local-only.` },
          { status: 400 },
        );
      }
      newModel = trimmed;
    }
  }
  // Default regenerate=true when the operator changed something
  // meaningful. They can opt out by passing { regenerate: false } if
  // they want to edit metadata without re-running the image-gen.
  const regenerate = b.regenerate === undefined ? true : Boolean(b.regenerate);

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
  const target = docRows[rowIndex] as Record<string, unknown>;

  if (newPrompt !== undefined) target.ai_image_prompt = newPrompt;
  if (newModel === null) {
    delete target.image_model_override;
  } else if (newModel !== undefined) {
    target.image_model_override = newModel;
  }
  if (regenerate) {
    delete target.image_url;
    delete target.mouth_removed_url;
    delete target.motion_collage_image_url;
    delete target.motion_collage_panel_urls;
    delete target.attempts;
    delete target.last_error;
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

  // Flip a terminally-failed video back to active so the cron picks
  // it up. Harmless when the stage is already active.
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

  logger.info('auto-pipeline: image-progress row edit', {
    pipeline_video_id: videoId,
    workspace_id: session.ws,
    row_index: rowIndex,
    prompt_changed: newPrompt !== undefined,
    model_changed: newModel !== undefined,
    regenerate,
  });

  return NextResponse.json({ ok: true });
});

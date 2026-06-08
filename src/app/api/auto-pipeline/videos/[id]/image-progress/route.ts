/**
 * GET /api/auto-pipeline/videos/[id]/image-progress
 *
 * Per-row visibility into the image-gen stage. Returns the parsed
 * production_doc artefact with computed status per row, so the UI
 * can render exactly which images are done / pending / failed
 * instead of just "generating_production_doc_images · live · 1h ago".
 *
 * The stage handler writes `image_url` on each row as it succeeds,
 * `attempts` + `last_error` on each failure, and persists the entire
 * doc back to `pipeline_stage_artefacts.metadata_jsonb` at the end
 * of every tick. We just parse + project.
 *
 * Workspace-scoped via the same FK chain the rest of the auto-
 * pipeline API uses (pipeline_run_videos -> pipeline_runs ->
 * workspace_id). A cross-workspace id returns 404.
 */

import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { DEFAULT_CLOUD_I2I_MODEL, I2I_MODELS } from '@/lib/image-models-i2i';

interface ImageRowMetadata {
  ai_image_prompt?: string;
  visual_type?: string;
  on_screen_text?: string;
  section_title?: string;
  image_url?: string;
  mouth_removed_url?: string;
  motion_collage_image_url?: string;
  motion_collage_panel_urls?: string[];
  character_id?: string;
  scene_id?: string;
  shot_kind?: string;
  variant_index?: number;
  group_id?: string;
  attempts?: number;
  last_error?: {
    class: string;
    message: string;
    at: string;
  } | null;
  image_model_override?: string;
}

interface ImageDocMetadata {
  rows?: ImageRowMetadata[];
  style_preset?: string;
  image_model_override?: string;
}

/** Retry budget per error class. Mirrors RETRY_BUDGETS in
 *  generate-production-doc-images.ts. Kept in sync manually because
 *  duplicating one tiny map beats coupling the API route to the
 *  stage handler's internals. */
const RETRY_BUDGETS: Record<string, number> = {
  content_policy: 1,
  reference_rejected: 2,
  model_rejected: 2,
  blank_output: 3,
  timeout: 3,
  invalid_prompt: 1,
  no_refs: 1,
  source_missing: 1,
  killed: 0,
  validation_failed: 2,
  unknown: 3,
};

export type RowStatus =
  | 'done'        // image_url set, no companion work pending
  | 'pending'     // no image_url yet, no error, awaiting cron pickup
  | 'in_progress' // has had attempts but no error AND no url (rare)
  | 'retrying'    // last_error set but attempts < budget — next tick will retry
  | 'exhausted'   // last_error set AND attempts >= budget — manual retry needed
  | 'skipped';    // no ai_image_prompt to begin with (title cards, etc.)

interface RowProgress {
  index: number;
  status: RowStatus;
  prompt_preview: string;
  visual_type: string | null;
  on_screen_text: string | null;
  thumbnail_url: string | null;
  attempts: number;
  last_error: { class: string; message: string; at: string } | null;
  retry_budget: number | null;
  group_id: string | null;
  variant_index: number;
  /** Per-row image model override, if set. */
  image_model_override: string | null;
}

function computeStatus(row: ImageRowMetadata): RowStatus {
  const hasUrl = typeof row.image_url === 'string' && row.image_url.trim().length > 0;
  const hasError = !!row.last_error;
  const attempts = row.attempts ?? 0;
  // Title cards / overlay rows etc. that the stage doesn't touch
  // come back without a prompt; surface them as "skipped" so the UI
  // doesn't show them as "stuck pending".
  const prompt = (row.ai_image_prompt ?? '').trim();
  const isVariant = (row.variant_index ?? 0) > 0;
  const hasPromptOrEdit = isVariant
    ? prompt.length > 0 // variants reuse the base prompt in display; treat empty as no work
    : prompt.length > 0;
  if (!hasUrl && !hasPromptOrEdit && !hasError) return 'skipped';

  if (hasUrl) return 'done';
  if (hasError) {
    const budget = RETRY_BUDGETS[row.last_error!.class] ?? 1;
    return attempts >= budget ? 'exhausted' : 'retrying';
  }
  if (attempts > 0) return 'in_progress';
  return 'pending';
}

export const GET = apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
  const { id: videoId } = await ctx.params;

  // Resolve the video + workspace scope.
  const { rows: videoRows } = await sql.query<{
    id: string;
    stage: string;
    pipeline_run_id: string;
    workspace_id: string;
  }>(
    `
    SELECT v.id::text AS id, v.stage, v.pipeline_run_id::text AS pipeline_run_id,
           v.workspace_id::text AS workspace_id
      FROM pipeline_run_videos v
     WHERE v.id = $1::uuid AND v.workspace_id = $2::uuid
     LIMIT 1
    `,
    [videoId, session.ws],
  );
  if (videoRows.length === 0) {
    return NextResponse.json({ error: 'video not found' }, { status: 404 });
  }
  const video = videoRows[0];

  // Pull the latest production_doc artefact. Pipeline_stage_artefacts
  // has a composite PK; ORDER BY attempt_number DESC for the freshest.
  const { rows: artefactRows } = await sql.query<{
    metadata_jsonb: Record<string, unknown> | null;
    attempt_number: number;
    image_gen_cost_usd: string | null;
  }>(
    `
    SELECT psa.metadata_jsonb,
           psa.attempt_number,
           (psa.metadata_jsonb->>'image_gen_stage_cost_usd') AS image_gen_cost_usd
      FROM pipeline_stage_artefacts psa
      JOIN pipeline_run_videos prv ON prv.id = psa.pipeline_run_video_id
     WHERE psa.pipeline_run_video_id = $1::uuid
       AND prv.workspace_id = $2::uuid
       AND psa.stage = 'generating_production_doc'
       AND psa.artefact_kind = 'production_doc'
     ORDER BY psa.attempt_number DESC
     LIMIT 1
    `,
    [video.id, session.ws],
  );
  if (artefactRows.length === 0 || !artefactRows[0].metadata_jsonb) {
    return NextResponse.json({
      stage: video.stage,
      rows: [],
      counts: { total: 0, done: 0, pending: 0, retrying: 0, exhausted: 0, skipped: 0 },
      cost_usd: 0,
      message: 'No production_doc artefact yet. The image-gen stage will start once the shot-list stage completes.',
    });
  }
  const metadata = artefactRows[0].metadata_jsonb as Record<string, unknown>;
  const doc = (metadata.doc as ImageDocMetadata | undefined) ?? {};
  const docRows = Array.isArray(doc.rows) ? doc.rows : [];

  const rows: RowProgress[] = docRows.map((row, index) => {
    const status = computeStatus(row);
    const prompt = (row.ai_image_prompt ?? '').trim();
    return {
      index,
      status,
      prompt_preview: prompt.slice(0, 200),
      visual_type: row.visual_type ?? null,
      on_screen_text: (row.on_screen_text ?? '').trim() || null,
      thumbnail_url: row.image_url ?? row.motion_collage_image_url ?? null,
      attempts: row.attempts ?? 0,
      last_error: row.last_error ?? null,
      retry_budget: row.last_error ? (RETRY_BUDGETS[row.last_error.class] ?? null) : null,
      group_id: row.group_id ?? null,
      variant_index: row.variant_index ?? 0,
      image_model_override: row.image_model_override ?? null,
    };
  });

  const counts = {
    total: rows.length,
    done: rows.filter((r) => r.status === 'done').length,
    pending: rows.filter((r) => r.status === 'pending' || r.status === 'in_progress').length,
    retrying: rows.filter((r) => r.status === 'retrying').length,
    exhausted: rows.filter((r) => r.status === 'exhausted').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
  };

  // Surface the registry of available i2i models so the UI picker
  // can show every option with its cost hint + label. The doc-level
  // override (if any) is the current "default" the operator sees;
  // unset means "use the style preset's preferred_cloud_model".
  const availableModels = I2I_MODELS
    // The auto-pipeline can't run local ComfyUI models — filter them
    // so the operator doesn't pick something that'd silently skip.
    .filter((m) => m.provider !== 'comfyui-local')
    .map((m) => ({
      value: m.value,
      label: m.label,
      provider: m.provider,
      hint: m.hint ?? null,
    }));

  return NextResponse.json({
    stage: video.stage,
    rows,
    counts,
    cost_usd: Number(artefactRows[0].image_gen_cost_usd ?? 0),
    style_preset: doc.style_preset ?? null,
    /** Doc-level model override — applied to every row that lacks
     *  its own override. Null means "fall through to style preset
     *  (or DEFAULT_CLOUD_I2I_MODEL)". */
    doc_image_model_override: doc.image_model_override ?? null,
    default_model: DEFAULT_CLOUD_I2I_MODEL,
    available_models: availableModels,
  });
});

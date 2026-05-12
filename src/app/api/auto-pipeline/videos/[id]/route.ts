import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';

/**
 * GET /api/auto-pipeline/videos/[id]
 *
 * Per-video detail for the script gate, panel-verdict panel,
 * and the auto-applied fix list. Returns:
 *   - the video row + linked idea metadata
 *   - the active script body + word count
 *   - the latest critic verdict (if any)
 *   - the latest applied-fixes artefact (for qa_retry UI)
 *   - the latest production doc (for the editor-assignment UI)
 *
 * Workspace-scoped — cross-workspace ids return 404.
 */
export const GET = apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
  const { id: videoId } = await ctx.params;

  const { rows: videoRows } = await sql.query<{
    id: string;
    pipeline_run_id: string;
    priority: number;
    stage: string;
    retry_count: number;
    failure_class: string | null;
    failure_message: string | null;
    cost_usd: string;
    idea_id: string | null;
    project_id: string | null;
    script_id: string | null;
    critic_panel_id: string | null;
    thumbnail_url: string | null;
    editor_assignment_id: string | null;
    narration_deadline_at: string | null;
    idea_title: string | null;
    idea_hook: string | null;
    idea_description: string | null;
    idea_niche: string | null;
    script_content: string | null;
    script_word_count: number | null;
    script_estimated_duration_seconds: number | null;
    verdict: Record<string, unknown> | null;
  }>(
    `
    SELECT v.id::text AS id,
           v.pipeline_run_id::text AS pipeline_run_id,
           v.priority, v.stage, v.retry_count,
           v.failure_class, v.failure_message,
           v.cost_usd::text AS cost_usd,
           v.idea_id::text AS idea_id,
           v.project_id::text AS project_id,
           v.script_id::text AS script_id,
           v.critic_panel_id::text AS critic_panel_id,
           v.thumbnail_url,
           v.editor_assignment_id::text AS editor_assignment_id,
           v.narration_deadline_at::text AS narration_deadline_at,
           vi.title AS idea_title,
           vi.hook AS idea_hook,
           vi.description AS idea_description,
           vi.niche AS idea_niche,
           s.content AS script_content,
           s.word_count AS script_word_count,
           s.estimated_duration_seconds AS script_estimated_duration_seconds,
           cp.verdict
      FROM pipeline_run_videos v
      LEFT JOIN video_ideas vi ON vi.id = v.idea_id
      LEFT JOIN scripts s ON s.id = v.script_id
      LEFT JOIN critic_panels cp ON cp.id = v.critic_panel_id
     WHERE v.id = $1::uuid AND v.workspace_id = $2::uuid
    `,
    [videoId, session.ws],
  );
  if (videoRows.length === 0) {
    return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
  }

  // Latest applied-fixes artefact (set on qa_retry attempts).
  // Source of truth for the UI's "fixes being applied" panel —
  // matches what the prompt augment received.
  const { rows: artefactRows } = await sql.query<{
    attempt_number: number;
    metadata_jsonb: Record<string, unknown> | null;
    created_at: string;
  }>(
    `
    SELECT attempt_number,
           metadata_jsonb,
           created_at::text AS created_at
      FROM pipeline_stage_artefacts
     WHERE pipeline_run_video_id = $1::uuid
       AND stage = 'qa_retry'
       AND artefact_kind = 'script_with_fixes'
     ORDER BY attempt_number DESC
     LIMIT 1
    `,
    [videoId],
  );
  const latestAppliedFixes = artefactRows[0] ?? null;

  // Latest production-doc artefact for the editor-handoff UI.
  const { rows: prodDocRows } = await sql.query<{
    metadata_jsonb: Record<string, unknown> | null;
  }>(
    `
    SELECT metadata_jsonb
      FROM pipeline_stage_artefacts
     WHERE pipeline_run_video_id = $1::uuid
       AND stage = 'generating_production_doc'
       AND artefact_kind = 'production_doc'
     ORDER BY attempt_number DESC
     LIMIT 1
    `,
    [videoId],
  );
  const latestProductionDoc = prodDocRows[0]?.metadata_jsonb ?? null;

  return NextResponse.json({
    video: videoRows[0],
    latestAppliedFixes,
    latestProductionDoc,
  });
});

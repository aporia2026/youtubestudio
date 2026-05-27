import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';

interface VideoRow {
  id: string;
  priority: number;
  stage: string;
  retry_count: number;
  failure_class: string | null;
  failure_message: string | null;
  cost_usd: string;
  idea_id: string | null;
  idea_title: string | null;
  idea_hook: string | null;
  script_id: string | null;
  script_word_count: number | null;
  critic_panel_id: string | null;
  critic_overall_score: number | null;
  thumbnail_url: string | null;
  editor_assignment_id: string | null;
  narration_deadline_at: string | null;
  updated_at: string;
  /** Non-null when the cron has this row checked out and is executing
   *  its stage handler right now. Read on the client as the strongest
   *  "is anything actually happening" signal. */
  claimed_at: string | null;
  /** Tick id that claimed the row. Useful to differentiate "claimed by
   *  the current tick (live)" from "stale claim (orchestrator crashed
   *  mid-handler)" once we surface tick-age in the UI. */
  claimed_by_tick: string | null;
}

/**
 * GET /api/auto-pipeline/runs/[id] — detail view for /pipeline/[id].
 *
 * Returns the run row + every video row (joined with the linked
 * idea + critic_panel score for the dashboard). Workspace-scoped.
 * Cross-workspace ids return 404 with no body leakage.
 */
export const GET = apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
  const { id } = await ctx.params;

  const { rows: runRows } = await sql.query<{
    id: string;
    preset_id: string;
    preset_name: string;
    status: string;
    ideas_count: number;
    estimated_cost_usd: string | null;
    actual_cost_usd: string;
    created_at: string;
    completed_at: string | null;
    script_gate_enabled: boolean;
    qa_min_score: string;
  }>(
    `
    SELECT r.id::text AS id,
           r.preset_id::text AS preset_id,
           p.name AS preset_name,
           r.status,
           r.ideas_count,
           r.estimated_cost_usd::text AS estimated_cost_usd,
           r.actual_cost_usd::text AS actual_cost_usd,
           r.created_at::text AS created_at,
           r.completed_at::text AS completed_at,
           p.script_gate_enabled,
           p.qa_min_score::text AS qa_min_score
      FROM pipeline_runs r
      JOIN pipeline_presets p ON p.id = r.preset_id
     WHERE r.id = $1::uuid AND r.workspace_id = $2::uuid
    `,
    [id, session.ws],
  );
  if (runRows.length === 0) {
    return NextResponse.json({ error: 'Pipeline run not found.' }, { status: 404 });
  }

  const { rows: videoRows } = await sql.query<VideoRow>(
    `
    SELECT v.id::text AS id,
           v.priority,
           v.stage,
           v.retry_count,
           v.failure_class,
           v.failure_message,
           v.cost_usd::text AS cost_usd,
           v.idea_id::text AS idea_id,
           vi.title AS idea_title,
           vi.hook AS idea_hook,
           v.script_id::text AS script_id,
           s.word_count AS script_word_count,
           v.critic_panel_id::text AS critic_panel_id,
           ((cp.verdict ->> 'overall_score')::numeric)::int AS critic_overall_score,
           v.thumbnail_url,
           v.editor_assignment_id::text AS editor_assignment_id,
           v.narration_deadline_at::text AS narration_deadline_at,
           v.updated_at::text AS updated_at,
           v.claimed_at::text AS claimed_at,
           v.claimed_by_tick
      FROM pipeline_run_videos v
      LEFT JOIN video_ideas vi ON vi.id = v.idea_id
      LEFT JOIN scripts s ON s.id = v.script_id
      LEFT JOIN critic_panels cp ON cp.id = v.critic_panel_id
     WHERE v.pipeline_run_id = $1::uuid
       AND v.workspace_id = $2::uuid
     ORDER BY v.priority ASC
    `,
    [id, session.ws],
  );

  return NextResponse.json({ run: runRows[0], videos: videoRows });
});

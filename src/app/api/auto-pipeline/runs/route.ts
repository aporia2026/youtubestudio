import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  createPipelineRun,
  CreatePipelineRunError,
} from '@/lib/auto-pipeline/create-run';

/**
 * GET  — list this workspace's pipeline runs (newest first).
 * POST — create a new run (fresh OR existing-idea mode).
 *
 * Per the Phase 8.1 pattern, every query is workspace-scoped.
 */
export const GET = apiRoute.authed(async (session) => {
  const { rows } = await sql.query<{
    id: string;
    preset_id: string;
    preset_name: string;
    status: string;
    ideas_count: number;
    estimated_cost_usd: string | null;
    actual_cost_usd: string;
    created_at: string;
    completed_at: string | null;
    video_count_total: number;
    video_count_done: number;
    video_count_failed: number;
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
           COUNT(v.id) AS video_count_total,
           COUNT(v.id) FILTER (WHERE v.stage = 'done') AS video_count_done,
           COUNT(v.id) FILTER (WHERE v.stage IN ('qa_failed_after_max_retries','narration_abandoned','production_doc_failed','thumbnail_failed','editor_assignment_failed','cancelled_by_user','cost_cap_exceeded')) AS video_count_failed
      FROM pipeline_runs r
      JOIN pipeline_presets p ON p.id = r.preset_id
      LEFT JOIN pipeline_run_videos v ON v.pipeline_run_id = r.id
     WHERE r.workspace_id = $1::uuid
     GROUP BY r.id, p.name
     ORDER BY r.created_at DESC
     LIMIT 100
    `,
    [session.ws],
  );
  return NextResponse.json({ runs: rows });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const presetId = typeof b.presetId === 'string' ? b.presetId : '';
  if (!presetId) {
    return NextResponse.json({ error: 'presetId is required' }, { status: 400 });
  }

  const channelId =
    typeof b.channelId === 'string' && b.channelId.length > 0 ? b.channelId : null;
  const countToGenerate =
    typeof b.countToGenerate === 'number' && Number.isFinite(b.countToGenerate)
      ? Math.floor(b.countToGenerate)
      : undefined;
  const existingIdeaIds = Array.isArray(b.existingIdeaIds)
    ? b.existingIdeaIds.filter((x): x is string => typeof x === 'string')
    : undefined;
  const existingScheduleItemIds = Array.isArray(b.existingScheduleItemIds)
    ? b.existingScheduleItemIds.filter((x): x is string => typeof x === 'string')
    : undefined;
  const estimatedCostUsd =
    typeof b.estimatedCostUsd === 'number' && Number.isFinite(b.estimatedCostUsd)
      ? b.estimatedCostUsd
      : null;

  try {
    const result = await createPipelineRun({
      workspaceId: session.ws,
      presetId,
      channelId,
      countToGenerate,
      existingIdeaIds,
      existingScheduleItemIds,
      estimatedCostUsd,
      createdBy: session.uid,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof CreatePipelineRunError) {
      const status =
        err.code === 'preset_not_found' ||
        err.code === 'idea_not_found' ||
        err.code === 'schedule_item_not_found'
          ? 404
          : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return domainErrorResponse(err, {
      op: 'auto-pipeline: create run',
      fallbackMessage: 'Failed to create pipeline run.',
    });
  }
});

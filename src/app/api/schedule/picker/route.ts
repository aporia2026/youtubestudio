import { NextResponse } from 'next/server';
import { sql, ensureScheduleSchema } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

/**
 * GET /api/schedule/picker — minimal, workspace-scoped list of
 * schedule items for the Start-a-batch picker on `/pipeline/new`.
 *
 * Why a dedicated endpoint instead of reusing GET /api/schedule:
 * the latter is unauthenticated/unscoped today (pre-existing) and
 * returns a heavy join shape with channels, editors, narrators,
 * series. The batch picker only needs the tiny shape below.
 *
 * Plan: `_plans/2026-05-26-batch-from-scheduled-items.md`.
 */
export const GET = apiRoute.authed(async (session) => {
  try {
    await ensureScheduleSchema();
    // pipeline_run_id is joined on the schedule item's
    // pipeline_run_video_id so the picker chip can deep-link to the run
    // (`/pipeline/{runId}`) without an extra round-trip. LEFT JOIN keeps
    // items that aren't linked to a run (the majority).
    const { rows } = await sql.query<{
      id: string;
      title: string;
      status: string;
      scheduled_for: string | null;
      idea_id: string | null;
      notes: string | null;
      pillar: string | null;
      position: number;
      pipeline_run_video_id: string | null;
      pipeline_run_id: string | null;
    }>(
      `
      SELECT si.id::text                    AS id,
             si.title,
             si.status,
             si.scheduled_for::text         AS scheduled_for,
             si.idea_id::text               AS idea_id,
             si.notes,
             si.pillar,
             si.position,
             si.pipeline_run_video_id::text AS pipeline_run_video_id,
             prv.pipeline_run_id::text      AS pipeline_run_id
        FROM schedule_items si
   -- Workspace filter on the LEFT JOIN defends against a stale
   -- pipeline_run_video_id that was pointed at a row from another
   -- workspace (shouldn't happen via the API, but the column has
   -- no DB-side workspace constraint).
   LEFT JOIN pipeline_run_videos prv
          ON prv.id = si.pipeline_run_video_id
         AND prv.workspace_id = si.workspace_id
       WHERE si.workspace_id = $1::uuid
       ORDER BY si.position ASC, si.created_at DESC
       LIMIT 500
      `,
      [session.ws],
    );
    return NextResponse.json({ items: rows });
  } catch (err) {
    logger.error('GET /api/schedule/picker error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ items: [], error: 'Failed' }, { status: 500 });
  }
});

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
    }>(
      `
      SELECT id::text AS id,
             title,
             status,
             scheduled_for::text AS scheduled_for,
             idea_id::text AS idea_id,
             notes,
             pillar,
             position,
             pipeline_run_video_id::text AS pipeline_run_video_id
        FROM schedule_items
       WHERE workspace_id = $1::uuid
       ORDER BY position ASC, created_at DESC
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

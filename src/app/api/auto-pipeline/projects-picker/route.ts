import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

/**
 * GET /api/auto-pipeline/projects-picker — minimal, workspace-scoped
 * list of projects suitable for the "Continue an existing video" mode
 * on `/pipeline/new`.
 *
 * Filters to projects that have a saved active script — without one,
 * the downstream production-doc handler would immediately fail its
 * invariant guard. Returns the smallest shape the picker UI needs:
 * id + title + niche + idea title + script summary.
 *
 * Plan: `_plans/2026-05-27-pipeline-continue-existing-video.md`.
 */
export const GET = apiRoute.authed(async (session) => {
  try {
    const { rows } = await sql.query<{
      id: string;
      title: string;
      niche: string | null;
      script_id: string;
      script_word_count: number | null;
      script_updated_at: string;
    }>(
      `
      SELECT p.id::text          AS id,
             p.title,
             p.niche,
             s.id::text          AS script_id,
             s.word_count        AS script_word_count,
             s.updated_at::text  AS script_updated_at
        FROM projects p
        JOIN scripts s ON s.project_id = p.id AND s.is_active = true
       WHERE p.workspace_id = $1::uuid
       ORDER BY s.updated_at DESC
       LIMIT 200
      `,
      [session.ws],
    );
    return NextResponse.json({ projects: rows });
  } catch (err) {
    logger.error('GET /api/auto-pipeline/projects-picker error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ projects: [], error: 'Failed' }, { status: 500 });
  }
});

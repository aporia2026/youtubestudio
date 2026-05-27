import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

/**
 * GET /api/auto-pipeline/feature-presets — single endpoint that
 * returns every per-feature preset list the pipeline preset form
 * needs to populate its bundle dropdowns:
 *
 *   - script_presets       (tone / audience / custom instructions / ...)
 *   - qa_presets           (min score / max iterations / hardening flags)
 *   - narration_presets    (deadline days / preferred narrator)
 *   - idea_presets         (niche / focus / video type / ...)
 *
 * Lighter wire shape than full CRUD per feature — the form only needs
 * id + name to render dropdowns. Editing/creating individual presets
 * lives on dedicated admin pages (follow-up); for now the form picks
 * from existing rows (including the ones migration 0097 backfilled).
 *
 * Plan: `_plans/2026-05-27-feature-preset-tables-bundle.md`.
 */
export const GET = apiRoute.authed(async (session) => {
  try {
    const [scriptRes, qaRes, narrationRes, ideaRes] = await Promise.all([
      sql.query<{ id: string; name: string; description: string | null }>(
        `SELECT id::text AS id, name, description
           FROM script_presets
          WHERE workspace_id = $1::uuid
          ORDER BY updated_at DESC`,
        [session.ws],
      ),
      sql.query<{ id: string; name: string; description: string | null }>(
        `SELECT id::text AS id, name, description
           FROM qa_presets
          WHERE workspace_id = $1::uuid
          ORDER BY updated_at DESC`,
        [session.ws],
      ),
      sql.query<{ id: string; name: string; description: string | null }>(
        `SELECT id::text AS id, name, description
           FROM narration_presets
          WHERE workspace_id = $1::uuid
          ORDER BY updated_at DESC`,
        [session.ws],
      ),
      sql.query<{ id: string; name: string; description: string | null }>(
        `SELECT id::text AS id, name, description
           FROM idea_presets
          WHERE workspace_id = $1::uuid
          ORDER BY updated_at DESC`,
        [session.ws],
      ),
    ]);
    return NextResponse.json({
      script: scriptRes.rows,
      qa: qaRes.rows,
      narration: narrationRes.rows,
      idea: ideaRes.rows,
    });
  } catch (err) {
    logger.error('GET /api/auto-pipeline/feature-presets error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { script: [], qa: [], narration: [], idea: [], error: 'Failed to load feature presets' },
      { status: 500 },
    );
  }
});

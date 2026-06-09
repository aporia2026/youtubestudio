import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';

/**
 * POST /api/shorts/[id]/retry
 *
 * Re-queue a failed short for the orchestrator to pick back up.
 * Clears `generation_progress` so `isShortTerminal` flips from
 * true → false and `nextStageFor` re-derives the next stage from
 * observable columns (short_script / voiceover_audio_url / seo_result /
 * style_assets / rendered_video_url). The next tick claims it
 * automatically.
 *
 * Plan: _plans/2026-06-09-bulk-shorts-robustness-and-inspector.md.
 *
 * Intentionally permissive: re-triggering a non-failed short is
 * harmless because `nextStageFor` returns 'terminal' for already-done
 * shorts and the orchestrator skips them.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const { rowCount } = await sql`
      UPDATE shorts
         SET generation_progress = '{}'::jsonb,
             updated_at = NOW()
       WHERE id = ${id}::uuid AND workspace_id = ${session.ws}::uuid
    `;

    if (rowCount === 0) {
      return NextResponse.json({ error: 'Short not found' }, { status: 404 });
    }

    console.info('[shorts-batch retry-short]', { short_id: id, workspace_id: session.ws });
    return NextResponse.json({ ok: true });
  },
);

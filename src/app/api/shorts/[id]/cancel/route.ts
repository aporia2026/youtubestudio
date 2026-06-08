import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';

/**
 * POST /api/shorts/[id]/cancel
 *
 * Marks a short as user-cancelled. Sets generation_progress.phase
 * to 'error' with a "Cancelled by user" message so the orchestrator
 * (and the asset cron) skip it on subsequent ticks. The short row
 * itself is kept — the user can revisit / delete it manually.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const now = new Date().toISOString();

    const { rowCount } = await sql`
      UPDATE shorts
         SET generation_progress = ${JSON.stringify({
           phase: 'error',
           label: 'Cancelled by user',
           error_message: 'Cancelled by user',
           updated_at: now,
         })}::jsonb,
             updated_at = NOW()
       WHERE id = ${id}::uuid AND workspace_id = ${session.ws}::uuid
    `;

    if (rowCount === 0) {
      return NextResponse.json({ error: 'Short not found' }, { status: 404 });
    }

    console.info('[shorts-batch cancel-short]', { short_id: id, workspace_id: session.ws });
    return NextResponse.json({ ok: true });
  },
);

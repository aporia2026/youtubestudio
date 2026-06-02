import { NextRequest, NextResponse } from 'next/server';

// Atlas T2I poll ceiling is ~285s (see atlas-cloud-images.ts), so the
// route needs the full 300s the asset-generation route uses. Mirrors
// `generate-style-assets/route.ts` rationale.
export const maxDuration = 300;

import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { regenerateBaseFrame } from '@/lib/shorts-frame-ops';

/**
 * POST /api/shorts/[id]/frames/base
 * Body: { prompt: string }
 *
 * Phase 15.12 — regenerate the BASE frame of a Doodle or Paint Short
 * with a new prompt. Persists the new `base_url` + `base_prompt` onto
 * `shorts.style_assets`. Existing variants are left in place; the user
 * can re-prompt them individually via the variant routes.
 *
 * Workspace-scoped (404 cross-tenant, no info leak). 422 when the row
 * is not on a frame-bearing style. Expected duration 30-90s.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: { prompt?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length < 8) {
      return NextResponse.json(
        { error: 'prompt must be a non-empty string (≥8 chars).' },
        { status: 400 },
      );
    }
    if (prompt.length > 4000) {
      return NextResponse.json({ error: 'prompt is too long (>4000 chars).' }, { status: 413 });
    }

    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });

      const result = await regenerateBaseFrame(row, { prompt });

      await sql`
        UPDATE shorts
           SET style_assets = ${JSON.stringify(result.style_assets)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts frames/base] persisted', {
        workspaceId: session.ws,
        shortId: row.id,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      });

      return NextResponse.json({
        style_assets: result.style_assets,
        estimated_cost_usd: result.costUsd,
      });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: regenerate base frame',
        fallbackMessage: 'Failed to regenerate the base frame.',
      });
    }
  },
);

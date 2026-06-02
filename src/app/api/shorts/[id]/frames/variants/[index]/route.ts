import { NextRequest, NextResponse } from 'next/server';

// POST regenerate hits Atlas Edit (~285s ceiling). DELETE is a pure
// data op; the same 300s ceiling is harmless on it.
export const maxDuration = 300;

import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { regenerateVariantFrame, deleteVariantFrame } from '@/lib/shorts-frame-ops';

interface Params {
  id: string;
  index: string;
}

function parseIndex(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * POST /api/shorts/[id]/frames/variants/[index]
 * Body: { prompt: string }
 *
 * Phase 15.12 — regenerate the variant at `index` with a new edit
 * prompt. Sources from the current `base_url`. Replaces the variant's
 * `url` + `edit_prompt`; preserves its `caption_chunk_start_index` so
 * the renderer-side timing stays put.
 *
 * Workspace-scoped (404 cross-tenant). Expected duration 15-25s.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<Params> }) => {
    const { id, index: rawIndex } = await ctx.params;
    const index = parseIndex(rawIndex);
    if (index === null) {
      return NextResponse.json(
        { error: 'index must be a non-negative integer.' },
        { status: 400 },
      );
    }

    let body: { prompt?: unknown } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length < 4) {
      return NextResponse.json(
        { error: 'prompt must be a non-empty string (≥4 chars).' },
        { status: 400 },
      );
    }
    if (prompt.length > 4000) {
      return NextResponse.json({ error: 'prompt is too long (>4000 chars).' }, { status: 413 });
    }

    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });

      const result = await regenerateVariantFrame(row, { index, prompt });

      await sql`
        UPDATE shorts
           SET style_assets = ${JSON.stringify(result.style_assets)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts frames/variants regenerate] persisted', {
        workspaceId: session.ws,
        shortId: row.id,
        index,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      });

      return NextResponse.json({
        style_assets: result.style_assets,
        estimated_cost_usd: result.costUsd,
      });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: regenerate variant frame',
        fallbackMessage: 'Failed to regenerate the variant frame.',
      });
    }
  },
);

/**
 * DELETE /api/shorts/[id]/frames/variants/[index]
 *
 * Phase 15.12 — remove the variant at `index`. Pure data op (no vendor
 * call, no cost). Workspace-scoped (404 cross-tenant).
 */
export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<Params> }) => {
    const { id, index: rawIndex } = await ctx.params;
    const index = parseIndex(rawIndex);
    if (index === null) {
      return NextResponse.json(
        { error: 'index must be a non-negative integer.' },
        { status: 400 },
      );
    }

    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });

      const result = deleteVariantFrame(row, { index });

      await sql`
        UPDATE shorts
           SET style_assets = ${JSON.stringify(result.style_assets)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts frames/variants delete] persisted', {
        workspaceId: session.ws,
        shortId: row.id,
        index,
      });

      return NextResponse.json({ style_assets: result.style_assets });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: delete variant frame',
        fallbackMessage: 'Failed to delete the variant frame.',
      });
    }
  },
);

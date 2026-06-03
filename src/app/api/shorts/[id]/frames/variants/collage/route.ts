import { NextRequest, NextResponse } from 'next/server';

// 4× T2I in parallel + sharp compose + R2 upload. Atlas T2I has a 285s
// poll ceiling per call but parallel waits don't sum; expected total is
// 30-90s. Match the rest of the frames/* routes at 300s.
export const maxDuration = 300;

import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import {
  appendCollageVariant,
  COLLAGE_PANEL_COUNT,
} from '@/lib/shorts-frame-collage';
import { getUserSettings } from '@/lib/user-settings';
import {
  DEFAULT_BASE_T2I_MODEL_ID,
  resolveBaseT2iModelId,
  type ShortsBaseT2iModelId,
} from '@/lib/shorts-base-t2i';

/** Resolve the per-panel T2I model. Same precedence as the single-frame
 *  base regen route: body > UserSettings > default. */
async function resolveModelId(
  bodyOverride: unknown,
  userId: string,
): Promise<ShortsBaseT2iModelId> {
  if (typeof bodyOverride === 'string' && bodyOverride.length > 0) {
    return resolveBaseT2iModelId(bodyOverride);
  }
  try {
    const settings = await getUserSettings(userId);
    return resolveBaseT2iModelId(settings.shorts_base_t2i_model_id ?? DEFAULT_BASE_T2I_MODEL_ID);
  } catch {
    return DEFAULT_BASE_T2I_MODEL_ID;
  }
}

/**
 * POST /api/shorts/[id]/frames/variants/collage
 * Body: {
 *   caption_chunk_start_index: number,
 *   panel_prompts: string[4],   // row-major: TL, TR, BL, BR
 *   model_id?: string,
 *   brief?: string,
 * }
 *
 * Phase 15.18 — append a new 2×2 collage variant to a Doodle / Paint
 * Short. The 4 panels generate in parallel via the user's base T2I
 * model, get composed server-side with sharp, and the composed image
 * gets persisted as a normal variant URL. Per-panel metadata stays on
 * `variant.collage` for the Shots panel surface.
 *
 * Cost: 4 × per-panel T2I + ~$0 for compose. Atlas default = $0.036;
 * Nano Banana = $0.16; Flux = $0.20.
 *
 * Workspace-scoped (404 cross-tenant). Expected duration 30-90s.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: {
      caption_chunk_start_index?: unknown;
      panel_prompts?: unknown;
      model_id?: unknown;
      brief?: unknown;
    } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const rawChunk = body.caption_chunk_start_index;
    if (typeof rawChunk !== 'number' || !Number.isFinite(rawChunk) || rawChunk < 0) {
      return NextResponse.json(
        { error: 'caption_chunk_start_index must be a non-negative number.' },
        { status: 400 },
      );
    }
    const captionChunkStartIndex = Math.floor(rawChunk);

    if (!Array.isArray(body.panel_prompts)) {
      return NextResponse.json(
        { error: `panel_prompts must be an array of ${COLLAGE_PANEL_COUNT} strings.` },
        { status: 400 },
      );
    }
    if (body.panel_prompts.length !== COLLAGE_PANEL_COUNT) {
      return NextResponse.json(
        { error: `panel_prompts must contain exactly ${COLLAGE_PANEL_COUNT} entries (got ${body.panel_prompts.length}).` },
        { status: 400 },
      );
    }
    const panelPrompts: string[] = [];
    for (let i = 0; i < body.panel_prompts.length; i++) {
      const p = body.panel_prompts[i];
      if (typeof p !== 'string') {
        return NextResponse.json(
          { error: `panel_prompts[${i}] must be a string.` },
          { status: 400 },
        );
      }
      if (p.trim().length > 4000) {
        return NextResponse.json(
          { error: `panel_prompts[${i}] is too long (>4000 chars).` },
          { status: 413 },
        );
      }
      panelPrompts.push(p);
    }
    const brief = typeof body.brief === 'string' ? body.brief.trim().slice(0, 600) : undefined;

    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });

      const baseT2iModelId = await resolveModelId(body.model_id, session.uid);
      const result = await appendCollageVariant(row, {
        captionChunkStartIndex,
        panelPrompts,
        baseT2iModelId,
        brief,
      });

      await sql`
        UPDATE shorts
           SET style_assets = ${JSON.stringify(result.style_assets)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts frames/variants/collage] persisted', {
        workspaceId: session.ws,
        shortId: row.id,
        chunkIndex: captionChunkStartIndex,
        newIndex: result.newIndex,
        baseT2iModelId,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      });

      return NextResponse.json({
        style_assets: result.style_assets,
        new_index: result.newIndex,
        estimated_cost_usd: result.costUsd,
      });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: append collage variant',
        fallbackMessage: 'Failed to append the collage variant.',
      });
    }
  },
);

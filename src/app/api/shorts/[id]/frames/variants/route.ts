import { NextRequest, NextResponse } from 'next/server';

// Atlas Edit poll ceiling is ~285s. Mirrors the base-regen route.
export const maxDuration = 300;

import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { appendVariantFrame } from '@/lib/shorts-frame-ops';
import { getUserSettings } from '@/lib/user-settings';
import type { Gpt2EditVendor } from '@/lib/gpt-image-2-edit';

/** See sibling [index]/route.ts for the precedence rationale. */
async function resolveVendor(
  bodyOverride: unknown,
  userId: string,
): Promise<Gpt2EditVendor> {
  if (bodyOverride === 'atlas' || bodyOverride === 'kie') return bodyOverride;
  const settings = await getUserSettings(userId);
  return settings.gpt_image_2_edit_primary ?? 'atlas';
}

/**
 * POST /api/shorts/[id]/frames/variants
 * Body: { prompt: string, caption_chunk_start_index: number }
 *
 * Phase 15.12 — append a NEW variant frame to a Doodle or Paint Short.
 * Generates the frame via Atlas Edit off the current base, inserts it
 * into the variants array sorted by `caption_chunk_start_index`, and
 * persists. Returns the new full `style_assets` plus the inserted
 * variant's index (so the UI can scroll to it).
 *
 * Workspace-scoped (404 cross-tenant). Expected duration 15-25s.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: {
      prompt?: unknown;
      caption_chunk_start_index?: unknown;
      gpt_image_2_edit_primary?: unknown;
    } = {};
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
    const rawChunk = body.caption_chunk_start_index;
    if (typeof rawChunk !== 'number' || !Number.isFinite(rawChunk) || rawChunk < 0) {
      return NextResponse.json(
        { error: 'caption_chunk_start_index must be a non-negative number.' },
        { status: 400 },
      );
    }
    const captionChunkStartIndex = Math.floor(rawChunk);

    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });

      const vendor = await resolveVendor(body.gpt_image_2_edit_primary, session.uid);
      const result = await appendVariantFrame(row, {
        prompt,
        captionChunkStartIndex,
        vendor,
      });

      await sql`
        UPDATE shorts
           SET style_assets = ${JSON.stringify(result.style_assets)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts frames/variants append] persisted', {
        workspaceId: session.ws,
        shortId: row.id,
        chunkIndex: captionChunkStartIndex,
        newIndex: result.newIndex,
        vendor,
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
        op: 'shorts: append variant frame',
        fallbackMessage: 'Failed to append the new variant frame.',
      });
    }
  },
);

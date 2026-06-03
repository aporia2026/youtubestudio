import { NextRequest, NextResponse } from 'next/server';

// Mirrors the base/animate route — see its docstring for the budget
// rationale.
export const maxDuration = 300;

import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { animateFrame, clearFrameAnimation } from '@/lib/shorts-frame-animate';
import { getUserSettings } from '@/lib/user-settings';
import { DEFAULT_BROLL_I2V_MODEL_ID } from '@/lib/broll-types';

interface Params {
  id: string;
  index: string;
}

function parseIndex(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

async function resolveModelId(
  bodyOverride: unknown,
  userId: string,
): Promise<string> {
  if (typeof bodyOverride === 'string' && bodyOverride.length > 0) return bodyOverride;
  try {
    const settings = await getUserSettings(userId);
    return settings.default_broll_i2v_model_id ?? DEFAULT_BROLL_I2V_MODEL_ID;
  } catch {
    return DEFAULT_BROLL_I2V_MODEL_ID;
  }
}

/**
 * POST /api/shorts/[id]/frames/variants/[index]/animate
 * Body: { model_id?: string, duration_seconds?: number, animation_prompt?: string }
 *
 * Phase 15.16 — animate one VARIANT frame into an i2v clip. See the
 * sibling base/animate route for the cost + duration model.
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

    let body: {
      model_id?: unknown;
      duration_seconds?: unknown;
      animation_prompt?: unknown;
    } = {};
    try {
      body = await req.json();
    } catch {
      // Empty body — same lazy-user tolerance as the base route.
    }

    const animationPrompt =
      typeof body.animation_prompt === 'string' ? body.animation_prompt.trim() : undefined;
    if (animationPrompt && animationPrompt.length > 1000) {
      return NextResponse.json(
        { error: 'animation_prompt is too long (>1000 chars).' },
        { status: 413 },
      );
    }
    let durationSeconds: number | undefined;
    if (body.duration_seconds !== undefined) {
      const n = Number(body.duration_seconds);
      if (!Number.isFinite(n) || n < 2 || n > 20) {
        return NextResponse.json(
          { error: 'duration_seconds must be a number between 2 and 20.' },
          { status: 400 },
        );
      }
      durationSeconds = n;
    }

    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });

      const modelId = await resolveModelId(body.model_id, session.uid);
      const result = await animateFrame(
        row,
        { kind: 'variant', index },
        { modelId, durationSeconds, animationPrompt },
      );

      await sql`
        UPDATE shorts
           SET style_assets = ${JSON.stringify(result.style_assets)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts frames/variants/animate] persisted', {
        workspaceId: session.ws,
        shortId: row.id,
        index,
        modelId: result.animation.model_id,
        videoUrl: result.animation.video_url,
        costUsd: result.animation.cost_usd,
        durationMs: result.durationMs,
      });

      return NextResponse.json({
        style_assets: result.style_assets,
        animation: result.animation,
      });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: animate variant frame',
        fallbackMessage: 'Failed to animate the variant frame.',
      });
    }
  },
);

/**
 * DELETE /api/shorts/[id]/frames/variants/[index]/animate
 *
 * Phase 15.16 — clear the variant's animation. Pure data op.
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

      const result = clearFrameAnimation(row, { kind: 'variant', index });

      await sql`
        UPDATE shorts
           SET style_assets = ${JSON.stringify(result.style_assets)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts frames/variants/animate delete] persisted', {
        workspaceId: session.ws,
        shortId: row.id,
        index,
      });

      return NextResponse.json({ style_assets: result.style_assets });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: clear variant animation',
        fallbackMessage: 'Failed to clear the variant animation.',
      });
    }
  },
);

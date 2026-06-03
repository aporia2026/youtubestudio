import { NextRequest, NextResponse } from 'next/server';

// i2v generations typically run 20-90s; Kling 3.0 Pro and Veo can
// drift to 120s. The dispatcher's poll ceiling is 285s; the route
// budget is 300s, matching the asset pipeline.
export const maxDuration = 300;

import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { animateFrame, clearFrameAnimation } from '@/lib/shorts-frame-animate';
import { getUserSettings } from '@/lib/user-settings';
import { DEFAULT_BROLL_I2V_MODEL_ID } from '@/lib/broll-types';

/** Resolve the i2v model id. Precedence:
 *    1. body `model_id` (per-call picker override)
 *    2. user setting `default_broll_i2v_model_id` (workspace default)
 *    3. `DEFAULT_BROLL_I2V_MODEL_ID` from the registry. */
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
 * POST /api/shorts/[id]/frames/base/animate
 * Body: { model_id?: string, duration_seconds?: number, animation_prompt?: string }
 *
 * Phase 15.16 — animate the BASE frame of a Doodle / Paint Short into
 * a 2-10s i2v clip. Synchronous: the route holds the connection open
 * for the full Kie poll (typically 20-90s, ceiling 285s).
 *
 * Cost: model-dependent ($0.06 Runway 5s → $1.68 Kling 3.0 4K 10s).
 * The picker UI surfaces price per model so the user picks knowingly.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: {
      model_id?: unknown;
      duration_seconds?: unknown;
      animation_prompt?: unknown;
    } = {};
    try {
      body = await req.json();
    } catch {
      // Empty body → use defaults. Endpoint tolerates "click Animate"
      // with no overrides for the lazy-user path (rule 10).
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
        { kind: 'base' },
        { modelId, durationSeconds, animationPrompt },
      );

      await sql`
        UPDATE shorts
           SET style_assets = ${JSON.stringify(result.style_assets)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts frames/base/animate] persisted', {
        workspaceId: session.ws,
        shortId: row.id,
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
        op: 'shorts: animate base frame',
        fallbackMessage: 'Failed to animate the base frame.',
      });
    }
  },
);

/**
 * DELETE /api/shorts/[id]/frames/base/animate
 *
 * Phase 15.16 — clear the base frame's animation, returning the row
 * to "still only" state. Pure data op (no vendor call, no cost). The
 * underlying mp4 is left orphaned on Kie's CDN.
 */
export const DELETE = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });

      const result = clearFrameAnimation(row, { kind: 'base' });

      await sql`
        UPDATE shorts
           SET style_assets = ${JSON.stringify(result.style_assets)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts frames/base/animate delete] persisted', {
        workspaceId: session.ws,
        shortId: row.id,
      });

      return NextResponse.json({ style_assets: result.style_assets });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: clear base animation',
        fallbackMessage: 'Failed to clear the base animation.',
      });
    }
  },
);

import { NextRequest, NextResponse } from 'next/server';

// Phase 15.16 — this route validates + enqueues, then kicks a background
// drain (fire-and-forget, same pattern as the render route) so work starts
// immediately without waiting for the next cron tick — and so it works on
// preview / local deploys where Vercel crons don't run at all. The drain is
// single-flight-locked; the production cron is the steady backstop + healer.
// The response returns in ~1s; the drain runs in the background up to this
// ceiling, persisting incrementally so a kill is never fatal. See
// `_plans/2026-06-03-shorts-asset-generation-reliability.md`.
export const maxDuration = 300;
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { splitScriptIntoCaptions } from '@/lib/shorts-render';
import { triggerShortsAssetDrain } from '@/lib/shorts-asset-cron';
import { WORDS_PER_SECOND, type GenerationProgressState } from '@/lib/shorts-types';
import { getShortStyle } from '@/lib/short-styles';
import { getUserSettings } from '@/lib/user-settings';
import type { Gpt2EditVendor } from '@/lib/gpt-image-2-edit';
import {
  DEFAULT_BASE_T2I_MODEL_ID,
  resolveBaseT2iModelId,
  type ShortsBaseT2iModelId,
} from '@/lib/shorts-base-t2i';

/**
 * POST /api/shorts/[id]/generate-style-assets
 * Body: { style_id?: 'doodle_explainer_2_short' | 'paint_explainer_v1_short' | 'minimal_gradient_v1', maxVariants?: number }
 *
 * Phase 15.3 / 15.16 — set the per-style render assets for a short_native
 * row. Routes by `style_id`:
 *   - 'minimal_gradient_v1'      → no-op, stamps style_id synchronously.
 *   - 'doodle_explainer_2_short' → enqueues for the background cron (202).
 *   - 'paint_explainer_v1_short' → enqueues for the background cron (202).
 *
 * Enqueue stashes the resolved niche + vendor + model + variant cap into
 * `generation_progress.job` so the cron (which has no user session) never
 * has to re-resolve them. Workspace-scoped (404 cross-tenant, no info leak).
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    let body: {
      style_id?: string;
      maxVariants?: number;
      niche?: string;
      /** Phase 15.14 — per-call vendor override. Body wins over the
       *  workspace default; both override the hardcoded 'atlas' floor. */
      gpt_image_2_edit_primary?: 'atlas' | 'kie';
      /** Phase 15.15 — per-call base T2I model override. */
      shorts_base_t2i_model_id?: string;
    } = {};
    try {
      body = await req.json();
    } catch {
      // No body → infer style from the row (or default to minimal).
    }

    // Vendor + model resolution mirrors the per-frame routes: body
    // override > UserSettings > default. Pulled OUTSIDE the row-loading
    // try/catch because a failed settings read should fail soft to
    // the cost-optimal defaults rather than fail the whole asset run.
    // One settings fetch covers both fields.
    let variantEditPrimary: Gpt2EditVendor = 'atlas';
    let baseT2iModelId: ShortsBaseT2iModelId = DEFAULT_BASE_T2I_MODEL_ID;
    try {
      const settings = await getUserSettings(session.uid);
      variantEditPrimary =
        body.gpt_image_2_edit_primary === 'atlas' || body.gpt_image_2_edit_primary === 'kie'
          ? body.gpt_image_2_edit_primary
          : settings.gpt_image_2_edit_primary ?? 'atlas';
      baseT2iModelId = resolveBaseT2iModelId(
        body.shorts_base_t2i_model_id ?? settings.shorts_base_t2i_model_id ?? DEFAULT_BASE_T2I_MODEL_ID,
      );
    } catch {
      variantEditPrimary =
        body.gpt_image_2_edit_primary === 'atlas' || body.gpt_image_2_edit_primary === 'kie'
          ? body.gpt_image_2_edit_primary
          : 'atlas';
      baseT2iModelId = resolveBaseT2iModelId(
        body.shorts_base_t2i_model_id ?? DEFAULT_BASE_T2I_MODEL_ID,
      );
    }

    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });
      if (row.medium !== 'short_native') {
        return NextResponse.json(
          { error: 'Style assets apply only to short_native rows.' },
          { status: 422 },
        );
      }
      if (!row.short_script || row.short_script.trim().length < 30) {
        return NextResponse.json(
          { error: 'Short has no script body to plan assets for.' },
          { status: 422 },
        );
      }

      // Pick the target style: explicit body > row's prior style_id > default.
      const requestedStyleId = body.style_id ?? row.style_id ?? 'minimal_gradient_v1';
      const styleEntry = getShortStyle(requestedStyleId);
      if (!styleEntry.available) {
        return NextResponse.json(
          {
            error: `Style "${styleEntry.id}" is not available yet${styleEntry.comingPhase ? ` (${styleEntry.comingPhase})` : ''}.`,
          },
          { status: 501 },
        );
      }

      // Minimal — no asset generation needed; just stamp the style id.
      if (styleEntry.id === 'minimal_gradient_v1') {
        await sql`
          UPDATE shorts
             SET style_id = ${styleEntry.id},
                 style_assets = '{}'::jsonb,
                 generation_progress = '{}'::jsonb,
                 generation_claimed_at = NULL,
                 generation_claimed_by_tick = NULL,
                 updated_at = NOW()
           WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
        `;
        logger.info('[shorts style-assets] minimal — no-op', {
          workspaceId: session.ws,
          shortId: row.id,
        });
        return NextResponse.json({ style_id: styleEntry.id, style_assets: {} });
      }

      // Doodle / Paint — enqueue for the background cron. No vendor work on
      // the request path.
      if (
        styleEntry.id === 'doodle_explainer_2_short' ||
        styleEntry.id === 'paint_explainer_v1_short'
      ) {
        // Niche resolution: explicit body > project's niche > 'general'.
        let niche = body.niche?.trim() ?? '';
        if (!niche && row.project_id) {
          const { rows } = await sql<{ niche: string | null }>`
            SELECT niche FROM projects
             WHERE id = ${row.project_id}::uuid
               AND workspace_id = ${session.ws}::uuid
             LIMIT 1
          `;
          if (rows[0]?.niche) niche = rows[0].niche;
        }
        if (!niche) niche = 'general';

        // Validate up front that the script chunks into captions, so the
        // user gets immediate feedback instead of a queued job that errors
        // a minute later. The cron recomputes these the same way.
        const seconds =
          row.voiceover_duration_seconds
          ?? row.estimated_duration_seconds
          ?? Math.max(15, Math.round((row.word_count ?? 0) / WORDS_PER_SECOND));
        const captions = splitScriptIntoCaptions(row.short_script, seconds * 1000);
        if (captions.length === 0) {
          return NextResponse.json(
            { error: 'Could not chunk the script into captions — needs a non-trivial script.' },
            { status: 422 },
          );
        }

        const now = new Date().toISOString();
        const queued: GenerationProgressState = {
          phase: 'queued',
          label: `Queued — ${styleEntry.id === 'paint_explainer_v1_short' ? 'Paint' : 'Doodle'} assets will start shortly…`,
          style_id: styleEntry.id,
          started_at: now,
          updated_at: now,
          job: {
            niche,
            base_t2i_model_id: baseT2iModelId,
            variant_edit_primary: variantEditPrimary,
            max_variants: body.maxVariants,
          },
        };

        await sql`
          UPDATE shorts
             SET style_id = ${styleEntry.id},
                 generation_progress = ${JSON.stringify(queued)}::jsonb,
                 generation_claimed_at = NULL,
                 generation_claimed_by_tick = NULL,
                 updated_at = NOW()
           WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
        `;

        logger.info('[shorts style-assets] enqueued', {
          workspaceId: session.ws,
          shortId: row.id,
          styleId: styleEntry.id,
          variantEditPrimary,
          baseT2iModelId,
        });

        // Kick the drain now (fire-and-forget) so the job starts without
        // waiting on the cron — and so it runs at all on preview / local
        // deploys where Vercel crons don't fire. Single-flight-locked, so
        // concurrent kicks (e.g. a batch of auto-created Shorts) collapse to
        // one drain rather than a vendor stampede. The function keeps running
        // until the drain finishes or maxDuration; the response already
        // returned. Mirrors the render route's background pattern.
        void triggerShortsAssetDrain('enqueue').catch((err) => {
          logger.warn('[shorts style-assets] background drain kick failed', {
            shortId: row.id,
            detail: err instanceof Error ? err.message : String(err),
          });
        });

        return NextResponse.json({ status: 'queued', style_id: styleEntry.id }, { status: 202 });
      }

      return NextResponse.json(
        { error: `Style "${styleEntry.id}" has no asset pipeline yet.` },
        { status: 501 },
      );
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: generate style assets',
        fallbackMessage: 'Failed to enqueue the Short style assets.',
      });
    }
  },
);

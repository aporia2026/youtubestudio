import { NextRequest, NextResponse } from 'next/server';

// Doodle / Paint asset pipelines run sequentially: LLM planner (~15s) +
// Atlas Image base (~30-60s) + N Atlas Edit variants (~15-25s each × 6
// variants). Typical real-world runs land at 100-225s. The default
// Vercel function timeout (60s on Hobby) was killing this mid-pipeline
// and leaving the client hung. Match the render-route + Mode B
// pattern of declaring 300s explicitly.
export const maxDuration = 300;
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { generateDoodleAssets } from '@/lib/shorts-doodle-asset-pipeline';
import { generatePaintAssets } from '@/lib/shorts-paint-asset-pipeline';
import { splitScriptIntoCaptions } from '@/lib/shorts-render';
import { WORDS_PER_SECOND, type GenerationProgressState } from '@/lib/shorts-types';
import { getShortStyle } from '@/lib/short-styles';
import { getUserSettings } from '@/lib/user-settings';
import type { Gpt2EditVendor } from '@/lib/gpt-image-2-edit';
import {
  DEFAULT_BASE_T2I_MODEL_ID,
  resolveBaseT2iModelId,
  type ShortsBaseT2iModelId,
} from '@/lib/shorts-base-t2i';

/** Persist a progress phase to the row. Tagged `updated_at` so the
 *  client's elapsed-per-phase math has a fresh anchor. Workspace-scoped
 *  so a stale id from somewhere else can't poison another tenant's
 *  progress strip. */
async function writeProgress(
  shortId: string,
  workspaceId: string,
  startedAt: string,
  state: GenerationProgressState,
): Promise<void> {
  const merged: GenerationProgressState = {
    ...state,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
  };
  await sql`
    UPDATE shorts
       SET generation_progress = ${JSON.stringify(merged)}::jsonb,
           updated_at = NOW()
     WHERE id = ${shortId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
}

/** Clear the progress field. Called on terminal success (after the
 *  final style_assets write lands) so the editor's poll stops the fast
 *  cadence. */
async function clearProgress(shortId: string, workspaceId: string): Promise<void> {
  await sql`
    UPDATE shorts
       SET generation_progress = '{}'::jsonb,
           updated_at = NOW()
     WHERE id = ${shortId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
}

/**
 * POST /api/shorts/[id]/generate-style-assets
 * Body: { style_id?: 'doodle_explainer_2_short' | 'paint_explainer_v1_short' | 'minimal_gradient_v1', maxVariants?: number }
 *
 * Phase 15.3 — generate the per-style render assets for a short_native
 * row. Routes to the right pipeline based on `style_id`:
 *   - 'minimal_gradient_v1'      → no-op (no assets needed); just stamps style_id.
 *   - 'doodle_explainer_2_short' → runs the Doodle asset pipeline.
 *   - 'paint_explainer_v1_short' → 501 until Phase 15.4.
 *
 * Returns the stored `style_assets` shape so the client can decide what
 * to render. Workspace-scoped (404 cross-tenant, no info leak).
 *
 * Expected duration:
 *   - minimal:  <1s
 *   - doodle:   30-120s (Atlas Image base + N variant edits)
 *   - paint:    n/a until Phase 15.4
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
                 updated_at = NOW()
           WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
        `;
        logger.info('[shorts style-assets] minimal — no-op', {
          workspaceId: session.ws,
          shortId: row.id,
        });
        return NextResponse.json({ style_id: styleEntry.id, style_assets: {} });
      }

      // Doodle path — run the pipeline.
      if (styleEntry.id === 'doodle_explainer_2_short') {
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

        // Build the same caption chunks the renderer will use so the
        // variant indices line up with what gets rendered.
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

        const jobStartedAt = new Date().toISOString();
        const assets = await generateDoodleAssets({
          workspaceId: session.ws,
          projectId: row.project_id,
          shortId: row.id,
          shortScript: row.short_script,
          hook: row.hook ?? undefined,
          payoff: row.payoff ?? undefined,
          title: row.title ?? undefined,
          niche,
          captions,
          maxVariants: body.maxVariants,
          variantEditPrimary,
          baseT2iModelId,
          onProgress: (state) => writeProgress(row.id, session.ws, jobStartedAt, state),
        }).catch(async (err) => {
          await writeProgress(row.id, session.ws, jobStartedAt, {
            phase: 'error',
            label: 'Doodle pipeline failed.',
            error_message: err instanceof Error ? err.message : String(err),
            style_id: 'doodle_explainer_2_short',
          });
          throw err;
        });

        const styleAssetsBlob = {
          doodle: {
            base_url: assets.base_url,
            base_prompt: assets.base_prompt,
            variants: assets.variants,
          },
        };

        await sql`
          UPDATE shorts
             SET style_id = ${styleEntry.id},
                 style_assets = ${JSON.stringify(styleAssetsBlob)}::jsonb,
                 updated_at = NOW()
           WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
        `;
        await clearProgress(row.id, session.ws);

        logger.info('[shorts style-assets] doodle persisted', {
          workspaceId: session.ws,
          shortId: row.id,
          baseUrl: assets.base_url,
          variantCount: assets.variants.length,
          variantEditPrimary,
          baseT2iModelId,
          estimatedCostUsd: assets.estimatedCostUsd,
        });

        return NextResponse.json({
          style_id: styleEntry.id,
          style_assets: styleAssetsBlob,
          estimated_cost_usd: assets.estimatedCostUsd,
        });
      }

      // Paint path — mirrors Doodle. Same caption-chunk plumbing, same
      // assets shape (just stored under `style_assets.paint` so the two
      // styles never overwrite each other on the row).
      if (styleEntry.id === 'paint_explainer_v1_short') {
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

        const jobStartedAt = new Date().toISOString();
        const assets = await generatePaintAssets({
          workspaceId: session.ws,
          projectId: row.project_id,
          shortId: row.id,
          shortScript: row.short_script,
          hook: row.hook ?? undefined,
          payoff: row.payoff ?? undefined,
          title: row.title ?? undefined,
          niche,
          captions,
          maxVariants: body.maxVariants,
          variantEditPrimary,
          baseT2iModelId,
          onProgress: (state) => writeProgress(row.id, session.ws, jobStartedAt, state),
        }).catch(async (err) => {
          await writeProgress(row.id, session.ws, jobStartedAt, {
            phase: 'error',
            label: 'Paint pipeline failed.',
            error_message: err instanceof Error ? err.message : String(err),
            style_id: 'paint_explainer_v1_short',
          });
          throw err;
        });

        const styleAssetsBlob = {
          paint: {
            base_url: assets.base_url,
            base_prompt: assets.base_prompt,
            variants: assets.variants,
          },
        };

        await sql`
          UPDATE shorts
             SET style_id = ${styleEntry.id},
                 style_assets = ${JSON.stringify(styleAssetsBlob)}::jsonb,
                 updated_at = NOW()
           WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
        `;
        await clearProgress(row.id, session.ws);

        logger.info('[shorts style-assets] paint persisted', {
          workspaceId: session.ws,
          shortId: row.id,
          baseUrl: assets.base_url,
          variantCount: assets.variants.length,
          variantEditPrimary,
          baseT2iModelId,
          estimatedCostUsd: assets.estimatedCostUsd,
        });

        return NextResponse.json({
          style_id: styleEntry.id,
          style_assets: styleAssetsBlob,
          estimated_cost_usd: assets.estimatedCostUsd,
        });
      }

      return NextResponse.json(
        { error: `Style "${styleEntry.id}" has no asset pipeline yet.` },
        { status: 501 },
      );
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: generate style assets',
        fallbackMessage: 'Failed to generate the Short style assets.',
      });
    }
  },
);

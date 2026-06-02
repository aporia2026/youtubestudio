import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { getShort } from '@/lib/shorts';
import { generateDoodleAssets } from '@/lib/shorts-doodle-asset-pipeline';
import { splitScriptIntoCaptions } from '@/lib/shorts-render';
import { WORDS_PER_SECOND } from '@/lib/shorts-types';
import { getShortStyle } from '@/lib/short-styles';

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
    let body: { style_id?: string; maxVariants?: number; niche?: string } = {};
    try {
      body = await req.json();
    } catch {
      // No body → infer style from the row (or default to minimal).
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
        });

        const styleAssetsBlob = {
          doodle: {
            base_url: assets.base_url,
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

        logger.info('[shorts style-assets] doodle persisted', {
          workspaceId: session.ws,
          shortId: row.id,
          baseUrl: assets.base_url,
          variantCount: assets.variants.length,
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

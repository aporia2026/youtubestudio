import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { getShort } from '@/lib/shorts';
import {
  buildNativeShortSeoPrompt,
  parseShortSeoResult,
} from '@/lib/shorts-seo';

/**
 * POST /api/shorts/[id]/seo-native
 *
 * SEO grading for a `short_native` row (Phase 15.2). Uses the
 * `buildNativeShortSeoPrompt` flow which differs from the external_seo
 * path:
 *   - No #Shorts in title/description (Phase 0 verified — auto-classified).
 *   - Description target ≤150 chars (above-the-fold mobile).
 *   - 3-5 hashtags, no "Shorts" injection.
 *
 * Persists the result back onto the row via `seo_result JSONB` so the
 * panel can re-render saved suggestions on next load.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });
      if (row.medium !== 'short_native') {
        return NextResponse.json(
          { error: 'Native SEO grading applies only to short_native rows.' },
          { status: 422 },
        );
      }
      if (!row.short_script || row.short_script.trim().length < 30) {
        return NextResponse.json(
          { error: 'Short has no script body to grade.' },
          { status: 422 },
        );
      }

      // Niche heuristic: prefer the project's niche; fall back to a
      // generic placeholder so the prompt still works for unlinked Shorts.
      let niche = 'general';
      if (row.project_id) {
        const { rows } = await sql<{ niche: string | null }>`
          SELECT niche FROM projects
           WHERE id = ${row.project_id}::uuid
             AND workspace_id = ${session.ws}::uuid
           LIMIT 1
        `;
        if (rows[0]?.niche) niche = rows[0].niche;
      }

      const modelId = await getEffectiveModelId(session.ws, 'shorts-seo');
      const { system, user } = buildNativeShortSeoPrompt({
        generatedTitle: row.title ?? undefined,
        shortScript: row.short_script,
        hook: row.hook ?? undefined,
        payoff: row.payoff ?? undefined,
        lengthSeconds: row.estimated_duration_seconds ?? 45,
        niche,
      });

      const raw = await generateText({
        modelId,
        systemPrompt: system,
        prompt: user,
        maxTokens: 2000,
        temperature: 0.5,
        spend: {
          workspaceId: session.ws,
          projectId: row.project_id ?? null,
          featureArea: 'shorts_seo_native',
          metadata: { short_id: row.id, niche: niche.slice(0, 40) },
        },
      });

      const result = parseShortSeoResult(raw);

      // Persist seo_result on the row so re-opening the panel shows the
      // last-graded options without re-burning AI cost.
      await sql`
        UPDATE shorts
           SET seo_result = ${JSON.stringify(result)}::jsonb,
               updated_at = NOW()
         WHERE id = ${row.id}::uuid AND workspace_id = ${session.ws}::uuid
      `;

      logger.info('[shorts seo-native]', {
        workspaceId: session.ws,
        shortId: row.id,
        titlesReturned: result.titles.length,
        modelId,
      });

      return NextResponse.json({ seo: result, modelId });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: SEO (native)',
        fallbackMessage: 'Failed to grade SEO for this Short.',
      });
    }
  },
);

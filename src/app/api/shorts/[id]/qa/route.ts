import { NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { getShort } from '@/lib/shorts';
import {
  assembleQaResult,
  buildShortsQaPrompt,
  parseShortsQa,
} from '@/lib/shorts-qa';

/**
 * POST /api/shorts/[id]/qa
 *
 * Lean Shorts QA on a `short_native` row. Single AI call, returns a
 * composite score + 5 graded criteria + 3 fixes. The hook score is
 * computed deterministically (Phase 1 helper) and combined server-side
 * so the client always receives a complete result.
 *
 * Returns 404 on cross-workspace ids. Returns 422 when the row's
 * `short_script` is missing (you can't QA a row that's only metadata).
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const row = await getShort(id, session.ws);
      if (!row) return NextResponse.json({ error: 'Short not found' }, { status: 404 });
      if (row.medium !== 'short_native') {
        return NextResponse.json(
          { error: 'QA applies only to short_native rows (Shorts you create from scratch).' },
          { status: 422 },
        );
      }
      if (!row.short_script || row.short_script.trim().length < 30) {
        return NextResponse.json(
          { error: 'Short has no script body to QA.' },
          { status: 422 },
        );
      }

      const modelId = await getEffectiveModelId(session.ws, 'shorts-qa');
      const { system, user } = buildShortsQaPrompt({
        scriptText: row.short_script,
        hookText: row.hook ?? undefined,
        payoffText: row.payoff ?? undefined,
      });

      const raw = await generateText({
        modelId,
        systemPrompt: system,
        prompt: user,
        maxTokens: 1200,
        temperature: 0.3,
        spend: {
          workspaceId: session.ws,
          projectId: row.project_id ?? null,
          featureArea: 'shorts_qa',
          metadata: { short_id: row.id },
        },
      });

      const parsed = parseShortsQa(raw);
      const result = assembleQaResult(
        {
          scriptText: row.short_script,
          hookText: row.hook ?? undefined,
          payoffText: row.payoff ?? undefined,
        },
        parsed,
      );

      logger.info('[shorts qa]', {
        workspaceId: session.ws,
        shortId: row.id,
        composite: result.composite,
        hookStrength: result.hookStrength.score,
        modelId,
      });

      return NextResponse.json({ qa: result, modelId });
    } catch (err) {
      return domainErrorResponse(err, {
        op: 'shorts: QA',
        fallbackMessage: 'Failed to grade the Short.',
      });
    }
  },
);

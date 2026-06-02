import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import {
  buildShortsIdeasPrompt,
  clampCount,
  parseShortsIdeas,
} from '@/lib/shorts-ideas';

/**
 * POST /api/shorts/ideas
 *
 * Hook-first Shorts idea generation. Single AI call, returns N graded
 * ideas with literal hook / title / payoff / thesis / shotConcept /
 * confidence per row.
 *
 * Body:
 *   - niche:   required, trimmed
 *   - context: optional extra prompt context
 *   - count:   optional, clamped to [3, 15]
 *   - modelId: optional override
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: { niche?: string; context?: string; count?: number; modelId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.niche !== 'string' || body.niche.trim().length === 0) {
    return NextResponse.json({ error: 'niche required' }, { status: 400 });
  }

  try {
    const modelId = body.modelId || (await getEffectiveModelId(session.ws, 'shorts-ideas'));
    const count = clampCount(body.count);
    const { system, user } = buildShortsIdeasPrompt({
      niche: body.niche.trim(),
      context: body.context?.trim(),
      count,
    });

    const raw = await generateText({
      modelId,
      systemPrompt: system,
      prompt: user,
      maxTokens: 3000,
      temperature: 0.85,
      spend: {
        workspaceId: session.ws,
        projectId: null,
        featureArea: 'shorts_ideas',
        metadata: { count, niche: body.niche.trim().slice(0, 60) },
      },
    });

    const ideas = parseShortsIdeas(raw);
    logger.info('[shorts ideas]', {
      workspaceId: session.ws,
      modelId,
      niche: body.niche.trim().slice(0, 60),
      countRequested: count,
      countReturned: ideas.length,
    });
    return NextResponse.json({ ideas, modelId });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: ideas',
      fallbackMessage: 'Failed to generate Shorts ideas.',
    });
  }
});

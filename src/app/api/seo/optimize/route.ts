import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { seoOptimizationPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`seo:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json({ error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` }, { status: 429 });
    }

    const { modelId, topic, niche, script, targetKeywords, existingTitle, additionalContext, descriptionStyle } = await req.json();

    if (!topic || !niche) {
      return NextResponse.json({ error: 'topic and niche are required' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    // Description-only style is opt-in: the client routes a borrowed
    // `youtube_description` template's content here instead of into
    // `additionalContext` so it doesn't influence titles / tags /
    // chapters. Empty / non-string values are normalised away so the
    // prompt builder cleanly skips the block.
    const normalisedDescriptionStyle = typeof descriptionStyle === 'string' && descriptionStyle.trim()
      ? descriptionStyle
      : undefined;

    logger.info('seo optimize start', {
      modelId,
      niche,
      hasAdditionalContext: typeof additionalContext === 'string' && additionalContext.trim().length > 0,
      hasDescriptionStyle: !!normalisedDescriptionStyle,
    });

    const { system, user } = seoOptimizationPrompt({
      topic,
      niche,
      script,
      targetKeywords,
      existingTitle,
      additionalContext: typeof additionalContext === 'string' && additionalContext.trim() ? additionalContext : undefined,
      descriptionStyle: normalisedDescriptionStyle,
    });

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 6000,
      temperature: 0.7,
      spend: await makeSpendContext('seo_optimize', { metadata: { niche } }),
    });

    let result;
    try {
      result = parseLlmJson(raw);
    } catch {
      return NextResponse.json({ error: 'Failed to parse SEO response — try again' }, { status: 500 });
    }

    return NextResponse.json({ result });
  } catch (err: unknown) {
    logger.error('SEO optimization error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'SEO optimization failed' },
      { status: 500 },
    );
  }
}

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

    const { modelId, topic, niche, script, targetKeywords, existingTitle, additionalContext } = await req.json();

    if (!topic || !niche) {
      return NextResponse.json({ error: 'topic and niche are required' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const { system, user } = seoOptimizationPrompt({
      topic,
      niche,
      script,
      targetKeywords,
      existingTitle,
      additionalContext: typeof additionalContext === 'string' && additionalContext.trim() ? additionalContext : undefined,
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

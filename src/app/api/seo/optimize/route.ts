import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { seoOptimizationPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`seo:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json({ error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` }, { status: 429 });
    }

    const { modelId, topic, niche, script, targetKeywords, existingTitle } = await req.json();

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
    });

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 6000,
      temperature: 0.7,
    });

    let result;
    try {
      result = parseLlmJson(raw);
    } catch {
      return NextResponse.json({ error: 'Failed to parse SEO response — try again' }, { status: 500 });
    }

    return NextResponse.json({ result });
  } catch (err: unknown) {
    console.error('SEO optimization error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'SEO optimization failed' },
      { status: 500 },
    );
  }
}

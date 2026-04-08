import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { ideaGenerationPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`ideas:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const { modelId, niche, count, audience, focus, videoType, referenceContext, redditContext, existingTitles } = await req.json();

    if (!niche) {
      return NextResponse.json({ error: 'niche is required' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const { system, user } = ideaGenerationPrompt({
      niche,
      count: Math.min(count || 10, 25),
      audience,
      focus,
      videoType,
      referenceContext,
      redditContext,
      existingTitles,
    });

    // More tokens needed when Reddit/reference attribution is included
    const hasAttribution = !!(referenceContext || redditContext);
    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: hasAttribution ? 12000 : 6000,
      temperature: 0.9,
    });

    let parsed;
    try {
      parsed = parseLlmJson(raw) as { ideas?: unknown[] };
    } catch {
      return NextResponse.json({ error: 'Failed to parse ideas response — try again' }, { status: 500 });
    }
    const ideas = parsed.ideas || [];

    return NextResponse.json({ ideas });
  } catch (err: unknown) {
    console.error('Ideas generation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 }
    );
  }
}

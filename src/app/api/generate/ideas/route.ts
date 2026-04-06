import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { ideaGenerationPrompt } from '@/lib/prompts';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
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

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 6000,
      temperature: 0.9,
    });

    // Extract JSON
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      return NextResponse.json({ error: 'Failed to parse ideas response' }, { status: 500 });
    }

    const parsed = JSON.parse(jsonMatch[1]);
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

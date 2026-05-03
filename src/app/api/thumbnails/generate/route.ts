import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { thumbnailConceptPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { makeSpendContext } from '@/lib/ai-spend';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`thumb:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json({ error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` }, { status: 429 });
    }

    const { modelId, title, niche, script, description } = await req.json();

    if (!title || !niche) {
      return NextResponse.json({ error: 'title and niche are required' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const { system, user } = thumbnailConceptPrompt({ title, niche, script, description });

    const raw = await generateText({
      modelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 8000,
      temperature: 0.8,
      spend: await makeSpendContext('thumbnail_concepts', { metadata: { niche } }),
    });

    let result;
    try {
      result = parseLlmJson(raw);
    } catch {
      return NextResponse.json({ error: 'Failed to parse thumbnail response — try again' }, { status: 500 });
    }

    return NextResponse.json({ result });
  } catch (err: unknown) {
    console.error('Thumbnail generation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Thumbnail generation failed' },
      { status: 500 },
    );
  }
}

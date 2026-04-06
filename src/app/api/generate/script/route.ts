import { NextRequest, NextResponse } from 'next/server';
import { generateTextStream, getModelById } from '@/lib/ai';
import { scriptGenerationPrompt } from '@/lib/prompts';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { modelId, topic, niche, duration, tone, style, audience, context, referenceContext } = await req.json();

    if (!topic || !niche) {
      return NextResponse.json({ error: 'topic and niche are required' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const { system, user } = scriptGenerationPrompt({
      topic,
      niche,
      targetDurationMinutes: duration || 7,
      tone,
      style,
      targetAudience: audience,
      additionalContext: context,
      referenceContext,
    });

    // Stream response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of generateTextStream({
            modelId,
            prompt: user,
            systemPrompt: system,
            maxTokens: 8000,
            temperature: 0.8,
          })) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err: unknown) {
    console.error('Script generation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 }
    );
  }
}

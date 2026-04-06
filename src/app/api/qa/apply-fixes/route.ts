import { NextRequest, NextResponse } from 'next/server';
import { generateTextStream, getDefaultModel } from '@/lib/ai';
import { applyFixesPrompt } from '@/lib/prompts';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { modelId, script, qaFeedback, approvedFixes } = await req.json();

    if (!script || !approvedFixes?.length) {
      return NextResponse.json({ error: 'script and approvedFixes required' }, { status: 400 });
    }

    const { system, user } = applyFixesPrompt({
      script,
      qaFeedback: qaFeedback || '',
      approvedFixes,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of generateTextStream({
            modelId: modelId || getDefaultModel().id,
            prompt: user,
            systemPrompt: system,
            maxTokens: 10000,
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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Apply fixes failed' },
      { status: 500 }
    );
  }
}

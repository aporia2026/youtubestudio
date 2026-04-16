import { NextRequest, NextResponse } from 'next/server';
import { generateTextStream, getModelById } from '@/lib/ai';
import { scriptGenerationPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`script:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const { modelId, topic, niche, duration, tone, style, audience, context, referenceContext, previousScripts } = await req.json();

    if (!topic || !niche) {
      return NextResponse.json({ error: 'topic and niche are required' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    // Fold recent scripts into additionalContext so the LLM avoids repeating
    // its own prior hooks/angles for this user. Matches the same mechanism
    // used by /api/generate/script-validated.
    const priors = Array.isArray(previousScripts) ? previousScripts.slice(0, 6).filter((s: unknown) => typeof s === 'string' && s) as string[] : [];
    const dedupNote = priors.length > 0
      ? `\n\nPREVIOUSLY GENERATED SCRIPTS — DO NOT REPEAT THESE HOOKS, OPENINGS, OR ANGLES:\n${priors.map((s, i) => `--- Prior #${i + 1} (first 400 chars) ---\n${s.slice(0, 400)}`).join('\n\n')}\nWrite a fundamentally different angle.`
      : '';

    const { system, user } = scriptGenerationPrompt({
      topic,
      niche,
      targetDurationMinutes: duration || 7,
      tone,
      style,
      targetAudience: audience,
      additionalContext: (context || '') + dedupNote,
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

import { NextRequest, NextResponse } from 'next/server';
import { generateText, generateTextStream, getModelById } from '@/lib/ai';
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

    const { modelId, topic, niche, duration, tone, style, audience, context, referenceContext, previousScripts, seriesContext, constraints } = await req.json();

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

    // Series continuity — the client has already budgeted the prior parts
    // (via /api/series/:id/parts) and built this block. It overrides the
    // no-repeat rule: for a series, the next part SHOULD reference prior
    // parts, so seriesContext goes first and the dedup note is suppressed
    // when series mode is active.
    const seriesBlock = typeof seriesContext === 'string' && seriesContext.trim() ? `\n\n${seriesContext.trim()}` : '';
    const additionalContext = seriesBlock
      ? (context || '') + seriesBlock
      : (context || '') + dedupNote;

    const { system, user } = scriptGenerationPrompt({
      topic,
      niche,
      targetDurationMinutes: duration || 7,
      tone,
      style,
      targetAudience: audience,
      additionalContext,
      referenceContext,
      constraints,
    });

    // Stream response.
    //
    // Some providers (notably GPT-4 Turbo via OpenAI, certain Kie-routed
    // models) silently return 200 with an empty body when max_tokens
    // exceeds their per-completion cap. Symptom: the stream closes with
    // zero chunks, the client shows "Script generated!" with no content.
    // Same root cause we patched in /api/qa/analyze (commit 64fc7fc).
    //
    // Mitigation: count chars as we stream. If the first pass produces
    // <100 chars, retry once non-streaming at a more conservative cap
    // (4000) that no current provider rejects, and enqueue the result.
    // If THAT also comes back empty, send a tagged error sentinel the
    // client can detect and surface as a real failure instead of a
    // misleading success.
    const encoder = new TextEncoder();
    const EMPTY_SENTINEL = '__EMPTY_RESPONSE__';
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let total = 0;
          for await (const chunk of generateTextStream({
            modelId,
            prompt: user,
            systemPrompt: system,
            maxTokens: 8000,
            temperature: 0.8,
          })) {
            total += chunk.length;
            controller.enqueue(encoder.encode(chunk));
          }
          if (total < 100) {
            try {
              const retry = await generateText({
                modelId,
                prompt: user,
                systemPrompt: system,
                maxTokens: 4000,
                temperature: 0.8,
              });
              if (retry && retry.trim().length >= 100) {
                controller.enqueue(encoder.encode(retry));
              } else {
                controller.enqueue(encoder.encode(EMPTY_SENTINEL));
              }
            } catch (retryErr) {
              const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              controller.enqueue(encoder.encode(`${EMPTY_SENTINEL}: retry failed (${msg})`));
            }
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

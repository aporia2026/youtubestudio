import { NextRequest, NextResponse } from 'next/server';
import { generateTextStream, getDefaultModel } from '@/lib/ai';
import { applyFixesPrompt } from '@/lib/prompts';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Streams a rewritten script that incorporates the user's approved QA fixes.
 *
 * Two-phase failure surface:
 *
 *   - Pre-flight (synchronous) failures — bad body, missing inputs, missing
 *     API keys, unknown modelId — return a plain JSON 4xx/5xx response so
 *     the client can read `body.error` and show it to the user.
 *
 *   - Mid-stream failures — provider rate-limits, function timeout, model
 *     hangs — surface inside the stream as an `[ERROR: ...]` marker so the
 *     client can salvage whatever has been generated so far. We can't switch
 *     status codes once headers are flushed.
 */
export async function POST(req: NextRequest) {
  try {
    const { modelId, script, qaFeedback, approvedFixes, constraints } = await req.json();

    if (!script?.trim()) {
      return NextResponse.json({ error: 'No script provided' }, { status: 400 });
    }
    if (!Array.isArray(approvedFixes) || approvedFixes.length === 0) {
      return NextResponse.json({ error: 'At least one approved fix is required' }, { status: 400 });
    }

    // Pre-flight check the model. `generateTextStream` would otherwise throw
    // inside the stream's start callback — by which time the 200 response
    // is already on the wire and the client can't see the proper error.
    const effectiveModelId = modelId || getDefaultModel().id;

    const { system, user } = applyFixesPrompt({
      script,
      qaFeedback: qaFeedback || '',
      approvedFixes,
      constraints,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of generateTextStream({
            modelId: effectiveModelId,
            prompt: user,
            systemPrompt: system,
            maxTokens: 10000,
            temperature: 0.8,
          })) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch (err) {
          // Echo the error into the stream as a sentinel so the client
          // can show a meaningful message instead of "stream just stopped".
          // `controller.error` would also work but Next.js's edge runtime
          // sometimes swallows that, leaving the client with an empty
          // result and no signal.
          const msg = err instanceof Error ? err.message : 'unknown stream error';
          logger.error('apply-fixes stream error', { detail: err instanceof Error ? err.message : String(err) });
          try { controller.enqueue(encoder.encode(`\n\n[ERROR: ${msg}]`)); } catch {}
          try { controller.close(); } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        // Vercel's edge buffers responses by default, which defeats the
        // streaming UX. This header opts the proxy out so chunks reach the
        // client as they're produced.
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Apply fixes failed';
    logger.error('apply-fixes pre-flight error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

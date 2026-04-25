import { NextRequest, NextResponse } from 'next/server';
import { generateText } from '@/lib/ai';
import { productionDocPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`prodoc:${getClientIP(req)}`, 5, 60_000);
    if (limited) {
      return NextResponse.json({ error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` }, { status: 429 });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { modelId, script, niche, topic, speakingPaceWpm, stylePreset, creativeBrief, startTimecodeSeconds, isChunk } = body as {
      modelId?: string; script?: string; niche?: string; topic?: string;
      speakingPaceWpm?: number; stylePreset?: string; creativeBrief?: string;
      startTimecodeSeconds?: number; isChunk?: boolean;
    };

    if (!script || !niche) {
      return NextResponse.json({ error: 'script and niche are required' }, { status: 400 });
    }
    if (script.trim().split(/\s+/).length < 20) {
      return NextResponse.json({ error: 'Script is too short — need at least 20 words' }, { status: 400 });
    }

    const { system, user } = productionDocPrompt({
      script, niche, topic, speakingPaceWpm, stylePreset, creativeBrief,
      startTimecodeSeconds: typeof startTimecodeSeconds === 'number' ? startTimecodeSeconds : 0,
      isChunk: isChunk === true,
    });

    const raw = await generateText({
      modelId: modelId || 'claude-sonnet-4-6',
      prompt: user,
      systemPrompt: system,
      maxTokens: 16000,
      temperature: 0.4,
    });

    let result;
    try {
      result = parseLlmJson(raw);
    } catch (parseErr) {
      // Surface the real cause so the client can distinguish truncation from
      // malformed JSON — generic "try again" hides a multi-minute failure.
      const detail = parseErr instanceof Error ? parseErr.message : 'unknown parser error';
      const tail = raw.slice(-120).replace(/\s+/g, ' ').trim();
      const looksTruncated = !raw.trimEnd().endsWith('}') && !raw.trimEnd().endsWith('```');
      const hint = looksTruncated ? ' (output appears truncated — model hit token cap)' : '';
      return NextResponse.json(
        { error: `Failed to parse production document${hint} — ${detail}. Tail: …${tail}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ result });
  } catch (err: unknown) {
    console.error('Production doc generation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 },
    );
  }
}

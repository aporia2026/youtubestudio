import { NextRequest, NextResponse } from 'next/server';
import { generateText } from '@/lib/ai';
import { productionDocPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { apiRoute } from '@/lib/route-helpers';
import { resolveStyle } from '@/lib/production-doc-styles';

export const maxDuration = 300;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
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
  const {
    modelId,
    script,
    niche,
    topic,
    speakingPaceWpm,
    stylePreset,
    creativeBrief,
    startTimecodeSeconds,
    isChunk,
  } = body as {
    modelId?: string; script?: string; niche?: string; topic?: string;
    speakingPaceWpm?: number;
    /** Either a built-in style slug ('cinematic', 'doodle_explainer', …)
     *  or a UUID pointing at a workspace-saved style row. */
    stylePreset?: string;
    creativeBrief?: string;
    startTimecodeSeconds?: number; isChunk?: boolean;
  };

  if (!script || !niche) {
    return NextResponse.json({ error: 'script and niche are required' }, { status: 400 });
  }
  if (script.trim().split(/\s+/).length < 20) {
    return NextResponse.json({ error: 'Script is too short — need at least 20 words' }, { status: 400 });
  }

  // Resolve the style id (built-in slug or saved-row UUID) into the full
  // payload the prompt builder needs. Unknown ids resolve to null — the
  // builder treats null as "no style" rather than failing the generation.
  const resolved = await resolveStyle(stylePreset, session.ws);
  const style = resolved
    ? {
        id: resolved.id,
        label: resolved.label,
        ai_image_suffix: resolved.ai_image_suffix,
        mixing_rules: resolved.mixing_rules,
        allow_overlay_stock: resolved.allow_overlay_stock,
      }
    : null;

  const { system, user } = productionDocPrompt({
    script, niche, topic, speakingPaceWpm, style, creativeBrief,
    startTimecodeSeconds: typeof startTimecodeSeconds === 'number' ? startTimecodeSeconds : 0,
    isChunk: isChunk === true,
  });

  const raw = await generateText({
    modelId: modelId || 'claude-sonnet-4-6',
    prompt: user,
    systemPrompt: system,
    maxTokens: 16000,
    temperature: 0.4,
    spend: {
      workspaceId: session.ws,
      featureArea: 'production_doc',
      metadata: { niche, is_chunk: isChunk === true },
    },
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
});

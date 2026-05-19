import { NextRequest, NextResponse } from 'next/server';
import { generateText } from '@/lib/ai';
import { productionDocPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { apiRoute } from '@/lib/route-helpers';
import { resolveStyle } from '@/lib/production-doc-styles';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { logger } from '@/lib/logger';
import {
  validateAndSplitOverlongRows,
  type ProductionDocRowLike,
} from '@/lib/production-doc-postprocess';

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
    overlaysDisabled,
  } = body as {
    modelId?: string; script?: string; niche?: string; topic?: string;
    speakingPaceWpm?: number;
    /** Either a built-in style slug ('cinematic', 'doodle_explainer', …)
     *  or a UUID pointing at a workspace-saved style row. */
    stylePreset?: string;
    creativeBrief?: string;
    startTimecodeSeconds?: number; isChunk?: boolean;
    /** Forwarded from the production-doc page's `overlays_disabled`
     *  toggle. When true, the prompt instructs the LLM to leave
     *  `overlay_stock_terms` empty on every row and bake brand
     *  identity into ai_image_prompt instead. */
    overlaysDisabled?: boolean;
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
    overlaysDisabled: overlaysDisabled === true,
  });

  const effectiveModelId = modelId || (await getEffectiveModelId(session.ws, 'production-doc'));

  // Catch the AI call here rather than letting it propagate to the route
  // wrapper's generic 500. Errors from generateText are domain-safe
  // explanations of upstream failure modes (Kie gateway down, model returned
  // empty, rate limited, timeout) — the user can act on them. The wrapper's
  // "Internal server error" mask is for DB / internal exceptions where the
  // text might leak schema details, not for AI provider responses.
  let raw: string;
  try {
    raw = await generateText({
      modelId: effectiveModelId,
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
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'AI generation failed';
    logger.error('production-doc generation failed', {
      detail,
      modelId: effectiveModelId,
      isChunk: isChunk === true,
      promptChars: (system?.length ?? 0) + user.length,
    });
    // 502 because the failure is upstream of us, not an internal bug.
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  if (!raw || raw.trim().length === 0) {
    logger.error('production-doc model returned empty output', {
      modelId: effectiveModelId,
      isChunk: isChunk === true,
    });
    return NextResponse.json(
      { error: `${effectiveModelId} returned an empty response — try the same model again, or switch models.` },
      { status: 502 },
    );
  }

  let result: {
    rows?: ProductionDocRowLike[];
    speaking_pace_wpm?: number;
    [k: string]: unknown;
  };
  try {
    result = parseLlmJson(raw) as typeof result;
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

  // Post-pass: enforce the 7s per-row narration ceiling. The prompt asks
  // the model to keep rows in the 4–6s range, but LLMs are unreliable at
  // length constraints — this deterministic pass catches any overruns and
  // splits them on sentence boundaries before the doc reaches the editor.
  // Title Card rows are exempt (they're 1–2s by design).
  let generation_warnings: string[] = [];
  if (Array.isArray(result.rows) && result.rows.length > 0) {
    const wpm =
      typeof result.speaking_pace_wpm === 'number'
        ? result.speaking_pace_wpm
        : typeof speakingPaceWpm === 'number'
          ? speakingPaceWpm
          : 135;
    const split = validateAndSplitOverlongRows(result.rows, wpm);
    if (split.overlongRowCount > 0) {
      logger.info('[production-doc post-validate]', {
        modelId: effectiveModelId,
        inputRowCount: result.rows.length,
        outputRowCount: split.rows.length,
        overlongRowCount: split.overlongRowCount,
        splitCount: split.splitCount,
        warningCount: split.warnings.length,
      });
      result.rows = split.rows;
      generation_warnings = split.warnings;
    }
  }

  return NextResponse.json({ result, generation_warnings });
});

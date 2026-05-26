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
  attachStyleSuffixToRows,
  validateAndSplitOverlongRows,
  type ProductionDocRowLike,
} from '@/lib/production-doc-postprocess';
import { extractScriptTitles, TITLE_SENTINEL_LEAK_RE } from '@/lib/script-titles';
import { preprocessSsmlForProductionDoc } from '@/lib/ssml-production-doc';

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

  // SSML preprocessor. Auto-detects scripts pasted as SSML (e.g.
  // <speak>...<break time="2s"/>...) and converts them into clean
  // plain text plus an ordered list of section bodies. The sections
  // become authoritative row-boundary hints for the LLM — no more
  // guessing where one beat ends and the next begins when the user
  // has already marked it. Plain-text input passes through unchanged.
  const ssmlPre = preprocessSsmlForProductionDoc(script);
  if (ssmlPre.wasSsml) {
    logger.info('[production-doc ssml-detected]', {
      inputBytes: Buffer.byteLength(script, 'utf8'),
      cleanScriptChars: ssmlPre.cleanScript.length,
      sectionCount: ssmlPre.sections.length,
    });
  }
  const scriptForPipeline = ssmlPre.wasSsml ? ssmlPre.cleanScript : script;

  // Deterministic title pre-pass. The LLM used to detect `##Heading` markers
  // itself, which was unreliable: a 6-title script could come back missing
  // titles silently. Now we extract them server-side per chunk and replace
  // each heading line with a `<<TITLE_N>>` sentinel before the LLM sees it.
  // The prompt then instructs the model to emit one Title Card row per
  // sentinel. Per-chunk scoping is automatic because the chunk's own text
  // is what gets parsed — no risk of titles from other chunks leaking in.
  const extracted = extractScriptTitles(scriptForPipeline);
  logger.info('[production-doc title-extract]', {
    inputScriptChars: scriptForPipeline.length,
    strippedScriptChars: extracted.stripped.length,
    titleCount: extracted.titles.length,
    titles: extracted.titles.map(t => t.text),
    isChunk: isChunk === true,
    warnings: extracted.warnings,
  });

  const { system, user } = productionDocPrompt({
    script: extracted.stripped,
    titles: extracted.titles,
    ssmlSections: ssmlPre.wasSsml ? ssmlPre.sections : undefined,
    niche, topic, speakingPaceWpm, style, creativeBrief,
    startTimecodeSeconds: typeof startTimecodeSeconds === 'number' ? startTimecodeSeconds : 0,
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

  // Title-card emission validator: confirm every extracted sentinel produced
  // exactly one Title Card row whose script_text matches the title text.
  // Surfaces missing/extra/leaked-sentinel cases as warnings so the user can
  // recover with the Promote / Split row actions instead of having to
  // re-generate the whole doc.
  if (Array.isArray(result.rows)) {
    const titleCardRows = result.rows.filter(
      r => r.visual_type === 'Title Card',
    );
    const emittedTexts = titleCardRows.map(r =>
      typeof r.script_text === 'string' ? r.script_text.trim() : '',
    );
    const expectedTexts = extracted.titles.map(t => t.text);

    const emittedCounts = new Map<string, number>();
    for (const t of emittedTexts) emittedCounts.set(t, (emittedCounts.get(t) ?? 0) + 1);

    const missing: string[] = [];
    for (const expected of expectedTexts) {
      const c = emittedCounts.get(expected) ?? 0;
      if (c === 0) missing.push(expected);
      else emittedCounts.set(expected, c - 1);
    }
    const extra: string[] = [];
    for (const [text, count] of emittedCounts) {
      for (let i = 0; i < count; i++) if (text) extra.push(text);
    }

    const leaked = result.rows
      .filter(r =>
        typeof r.script_text === 'string'
          ? TITLE_SENTINEL_LEAK_RE.test(r.script_text)
          : false,
      )
      .map(r => (typeof r.script_text === 'string' ? r.script_text : ''));

    logger.info('[production-doc title-emit]', {
      modelId: effectiveModelId,
      expected: expectedTexts.length,
      emitted: titleCardRows.length,
      missingCount: missing.length,
      missing,
      extraCount: extra.length,
      extra,
      leakedSentinelCount: leaked.length,
    });

    if (missing.length > 0) {
      generation_warnings.push(
        `Missing title card(s) — the model didn't emit a Title Card row for: ${missing
          .map(t => `"${t}"`)
          .join(', ')}. Use the "Make this a title card" row action to add them where they belong.`,
      );
    }
    if (extra.length > 0) {
      generation_warnings.push(
        `Unexpected title card(s) — the model emitted Title Cards we didn't request: ${extra
          .map(t => `"${t}"`)
          .join(', ')}. Review and delete if not wanted.`,
      );
    }
    if (leaked.length > 0) {
      generation_warnings.push(
        `Title sentinel leaked into row text on ${leaked.length} row(s). Edit the affected rows to remove the <<TITLE_N>> marker.`,
      );
    }
    if (extracted.warnings.length > 0) {
      generation_warnings.push(...extracted.warnings);
    }
  }

  // Post-pass: attach the chosen style's `ai_image_suffix` to every row's
  // `ai_image_prompt`. The LLM is instructed (see productionDocPrompt) to
  // emit only the 35–55 word scene body and leave the style attachment to
  // the server — this keeps each row's output under ~150 tokens and avoids
  // the verbose-suffix-per-row truncation that GPT-mini-class models hit on
  // long scripts. See plan `_plans/2026-05-26-production-doc-suffix-server-side.md`.
  if (Array.isArray(result.rows) && style?.ai_image_suffix) {
    const attach = attachStyleSuffixToRows(result.rows, style.ai_image_suffix);
    logger.info('[production-doc suffix-attach]', {
      modelId: effectiveModelId,
      rowCount: result.rows.length,
      attachedCount: attach.attachedCount,
      skippedAlreadyPresent: attach.skippedAlreadyPresent,
      skippedNonString: attach.skippedNonString,
      suffixChars: style.ai_image_suffix.length,
      suffixWords: style.ai_image_suffix.trim().split(/\s+/).length,
    });
  }

  // Pin the doc-level OST default from the chosen style when the style
  // has an opinion. doodle_explainer_2 sets `'overlay'` so the chunky
  // yellow-bubble LowerThird variant is what gets composited at render
  // time, instead of the diffusion prompt baking small black text into
  // the corner of every image. The LLM is told the same rule via the
  // style's mixing_rules, but its compliance is unreliable — server-
  // pinning the doc default removes the failure mode entirely. Only
  // overwrite when the LLM didn't already set a value (it shouldn't,
  // but guard so a future schema change doesn't get clobbered here).
  if (resolved?.default_on_screen_text_mode && result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r.on_screen_text_mode_default === undefined) {
      r.on_screen_text_mode_default = resolved.default_on_screen_text_mode;
      logger.info('[production-doc ost-mode-default]', {
        styleId: resolved.id,
        mode: resolved.default_on_screen_text_mode,
      });
    }
  }

  return NextResponse.json({ result, generation_warnings });
});

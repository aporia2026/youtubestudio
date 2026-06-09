/**
 * Step 1 of the Doodle Explainer pipeline: produce N distinct concept
 * variations for a single thumbnail brief. The route hands the LLM
 * output to the panel; the user reviews and edits if they want; the
 * panel then POSTs to the sibling `image/` route which fans out to N
 * parallel image-gen calls in the chosen image model.
 *
 * No vision needed — this LLM call is text-only. Cheap + fast.
 *
 * Rate limit: 10 req/min/IP (same ceiling as the other format LLM steps).
 *
 * Plan: _plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  buildDoodleConceptsSystemPrompt,
  buildDoodleConceptsUserPrompt,
  parseDoodleConceptsResponse,
  validateDoodleInput,
  type DoodleConcept,
} from '@/lib/thumbnail-formats/doodle-explainer-prompts';
import { resolveThumbnailStyle, DEFAULT_THUMBNAIL_STYLE_ID } from '@/lib/thumbnail-styles';
import { clampVariantCount } from '@/lib/thumbnail-variants';

export const maxDuration = 120;

/** Per-call LLM timeout. 90s gives the model room while still landing
 *  inside the 120s function budget with margin for retries. */
const LLM_CALL_TIMEOUT_MS = 90_000;

/** Models allowed for this LLM step. Vision NOT required (no reference
 *  image), so any text-capable Claude / GPT / Gemini works. The set is
 *  intentionally broad — the panel surfaces a model picker. */
const TEXT_ALLOWED = new Set<string>([
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5',
  'gpt-5-mini',
  'gemini-2.0-flash',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'kie-gemini-2.5-flash',
  'kie-gemini-2.5-pro',
  'kie-gemini-3-flash',
  'kie-gemini-3-pro',
  'kie-gemini-3.1-pro',
  'kie-gemini-3-5-flash',
  'kie-claude-opus-4-7',
  'kie-claude-opus-4-6',
  'kie-claude-sonnet-4-6',
  'kie-claude-sonnet-4-5',
  'kie-claude-opus-4-5',
  'kie-claude-haiku-4-5',
]);

interface ReqBody {
  modelId?: string;
  styleId?: string;
  hookText?: string;
  characterExpression?: string;
  backgroundScene?: string;
  customBackground?: string;
  videoContext?: string;
  variantCount?: number;
}

interface OkResponse {
  styleId: string;
  variantCount: number;
  concepts: DoodleConcept[];
}

function withTimeout<T>(promise: Promise<T>, ms: number, modelName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Model "${modelName}" took longer than ${Math.round(ms / 1000)}s. Try a faster model — Gemini Flash, Claude Haiku, or GPT-4o Mini.`,
      ));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const { limited, resetIn } = checkRateLimit(`thumb-doodle-concepts:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    let body: ReqBody;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const modelId = body.modelId;
    if (!modelId) return NextResponse.json({ error: 'modelId is required' }, { status: 400 });
    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: `Unknown model: ${modelId}` }, { status: 400 });
    if (!TEXT_ALLOWED.has(modelId)) {
      return NextResponse.json(
        { error: `Model "${model.name}" is not in the allowlist for this route. Pick a recent Claude / GPT / Gemini variant.` },
        { status: 400 },
      );
    }

    const styleId = body.styleId || DEFAULT_THUMBNAIL_STYLE_ID;
    const style = resolveThumbnailStyle(styleId);
    if (!style) return NextResponse.json({ error: `Unknown styleId: ${styleId}` }, { status: 400 });

    // Sanitise + length-cap free-text user input. Strips control chars,
    // rejects obvious prompt-injection sequences, clamps to safe lengths.
    const validation = validateDoodleInput({
      hookText: body.hookText,
      characterExpression: body.characterExpression,
      backgroundScene: body.backgroundScene,
      customBackground: body.customBackground,
      videoContext: body.videoContext,
      variantCount: body.variantCount,
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.reason }, { status: 400 });
    }
    const input = validation.value;
    // Defence in depth — even if clampVariantCount in the validator
    // miscounts, this enforces 1..3 again right at the LLM boundary
    // so a bug above can't trigger a giant LLM bill.
    input.variantCount = clampVariantCount(input.variantCount);

    logger.info('[thumb-doodle concepts] start', {
      modelId,
      styleId,
      variantCount: input.variantCount,
      hookLength: input.hookText.length,
      expression: input.characterExpression,
      backgroundScene: input.backgroundScene,
      hasCustomBackground: !!input.customBackground,
      videoContextLength: input.videoContext?.length ?? 0,
    });

    const systemPrompt = buildDoodleConceptsSystemPrompt();
    const userPrompt = buildDoodleConceptsUserPrompt(input, style);

    const llmStart = Date.now();
    const raw = await withTimeout(
      generateText({
        modelId,
        prompt: userPrompt,
        systemPrompt,
        maxTokens: 2000,
        // Higher temperature on this call — variants must differ from
        // each other, and the system prompt explicitly demands variety
        // across three axes. Low temp tends to collapse them.
        temperature: 0.9,
      }),
      LLM_CALL_TIMEOUT_MS,
      model.name,
    );

    let parsed: unknown;
    try {
      parsed = parseLlmJson(raw);
    } catch (err) {
      logger.warn('[thumb-doodle concepts] LLM response not JSON-parseable', {
        modelId,
        rawSnippet: raw.slice(0, 200),
        reason: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        {
          error: 'Concept generator returned malformed JSON. Try again or pick a different model.',
        },
        { status: 502 },
      );
    }

    const conceptsResult = parseDoodleConceptsResponse(parsed, input.variantCount);
    if (!conceptsResult.ok) {
      logger.warn('[thumb-doodle concepts] concepts schema validation failed', {
        modelId,
        reason: conceptsResult.reason,
      });
      return NextResponse.json(
        {
          error: `Concept generator returned an invalid shape: ${conceptsResult.reason}. Try again or pick a different model.`,
        },
        { status: 502 },
      );
    }

    const response: OkResponse = {
      styleId,
      variantCount: input.variantCount,
      concepts: conceptsResult.variants,
    };

    logger.info('[thumb-doodle concepts] done', {
      modelId,
      styleId,
      variantCount: input.variantCount,
      llmDurationMs: Date.now() - llmStart,
      totalDurationMs: Date.now() - startedAt,
      conceptLabels: conceptsResult.variants.map(v => v.conceptLabel),
    });

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[thumb-doodle concepts] fatal', {
      reason: message,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: `Concept generation failed: ${message}` },
      { status: 500 },
    );
  }
}

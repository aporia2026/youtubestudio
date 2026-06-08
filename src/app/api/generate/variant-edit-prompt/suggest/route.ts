import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { generateText } from '@/lib/ai';
import { logger } from '@/lib/logger';
import {
  buildVariantEditSuggestionSystemPrompt,
  buildVariantEditSuggestionUserPrompt,
  sanitiseSuggestion,
} from '@/lib/variant-edit-prompt';

/**
 * Suggest a small visual change for a variant row whose
 * `variant_edit_prompt` field is empty.
 *
 * When the user clicks "Generate variant" without filling the
 * EDIT INSTRUCTION textarea, the editor calls this endpoint first to
 * generate a sensible suggestion, persists it onto the row so the
 * user can see what was tried, then proceeds with the normal
 * Atlas Edit variant pipeline.
 *
 * Cheap LLM call — Haiku 4.5, capped at 240 chars of output, ~$0.0005
 * per request. Per-IP rate-limited to 60/min to keep abuse cheap.
 *
 * Plan: `_plans/2026-06-08-variant-edit-auto-suggest.md`.
 */

export const maxDuration = 30;

const SUGGEST_MODEL_ID = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 120;

interface PostBody {
  scriptText?: unknown;
  basePrompt?: unknown;
  stylePresetId?: unknown;
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const { limited } = checkRateLimit(`variant-edit-suggest:${getClientIP(req)}`, 60, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Too many suggestions — slow down.' }, { status: 429 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const scriptText = typeof body.scriptText === 'string' ? body.scriptText : undefined;
  const basePrompt = typeof body.basePrompt === 'string' ? body.basePrompt : undefined;
  const stylePresetId = typeof body.stylePresetId === 'string' ? body.stylePresetId : undefined;

  // At least one of the context fields needs to be non-empty. Without
  // any context the LLM would suggest something generic — better to
  // refuse than to mint a hallucination.
  if (!scriptText?.trim() && !basePrompt?.trim()) {
    return NextResponse.json(
      { error: 'scriptText or basePrompt is required to suggest an edit' },
      { status: 400 },
    );
  }

  const systemPrompt = buildVariantEditSuggestionSystemPrompt();
  const userPrompt = buildVariantEditSuggestionUserPrompt({
    scriptText, basePrompt, stylePresetId,
  });

  try {
    const raw = await generateText({
      modelId: SUGGEST_MODEL_ID,
      prompt: userPrompt,
      systemPrompt,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.7,
      spend: {
        workspaceId: session.ws,
        featureArea: 'variant_edit_prompt_suggest',
      },
    });
    const suggestion = sanitiseSuggestion(raw);
    if (!suggestion) {
      return NextResponse.json({ error: 'Empty suggestion output' }, { status: 502 });
    }
    logger.info('[variant-edit suggest] success', {
      output_chars: suggestion.length,
      workspace_id: session.ws,
    });
    return NextResponse.json({ suggestion });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[variant-edit suggest] failed', {
      detail: message,
      workspace_id: session.ws,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
});

import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import {
  topicCardGridLlmPrompt,
  parseCardListResult,
  validateCardList,
  type CardListResult,
  type LlmPromptInput,
} from '@/lib/thumbnail-formats/topic-card-grid';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';
import { assertSafePublicUrl } from '@/lib/url-safety';

export const maxDuration = 120;

/**
 * Step 1 of the Topic Card Grid pipeline: produce the ordered card list +
 * global palette. Cheap, fast LLM call. The user reviews / edits the output
 * before triggering Step 2 (the expensive image call).
 *
 * See `_plans/2026-05-19-thumbnail-format-topic-card-grid.md` for the
 * pipeline overview and the rationale for the banlist-based validation that
 * gates this endpoint's output before any image dollars are spent.
 */

// Same 8 MB cap as the multimodal reference path in /api/thumbnails/generate.
// Reference thumbnails are well under 1 MB in practice.
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

// Server-side sanity cap on grid dimensions. Plan said no UI cap; this is the
// runaway-prevention layer (50×50 = 2500 cards is wildly past any reasonable
// thumbnail and would produce a 30k+ char prompt).
const MAX_GRID_DIM = 50;

// Mirrors the VISION_ALLOWED set from /api/thumbnails/generate. Every model
// listed here has been verified to forward the `image` argument to its
// upstream API via generateText (see src/lib/ai.ts — anthropic/openai/google
// direct branches + the kie branch shipped on 2026-05-18 for Gemini + Claude
// via Kie).
const VISION_ALLOWED = new Set<string>([
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-4o',
  'gpt-4o-mini',
  'gemini-2.0-flash',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'kie-gemini-2.5-flash',
  'kie-gemini-2.5-pro',
  'kie-gemini-3-flash',
  'kie-gemini-3-pro',
  'kie-gemini-3.1-pro',
  'kie-claude-opus-4-7',
  'kie-claude-opus-4-6',
  'kie-claude-sonnet-4-6',
  'kie-claude-sonnet-4-5',
  'kie-claude-opus-4-5',
  'kie-claude-haiku-4-5',
]);

interface ReqBody {
  modelId?: string;
  title?: string;
  niche?: string;
  script?: string;
  description?: string;
  gridRows?: number;
  gridCols?: number;
  mode?: 'review' | 'pre-fill' | 'one-shot';
  prefilledLabels?: string[];
  referenceImageUrl?: string;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const { limited, resetIn } = checkRateLimit(`thumb-fmt-grid-cards:${getClientIP(req)}`, 10, 60_000);
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
    const title = (body.title || '').trim();
    const niche = (body.niche || '').trim();
    const gridRows = Number(body.gridRows);
    const gridCols = Number(body.gridCols);
    const mode = body.mode === 'pre-fill' || body.mode === 'one-shot' ? body.mode : 'review';

    if (!modelId) return NextResponse.json({ error: 'modelId is required' }, { status: 400 });
    if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });
    if (!niche) return NextResponse.json({ error: 'niche is required' }, { status: 400 });
    if (!Number.isInteger(gridRows) || gridRows < 1 || gridRows > MAX_GRID_DIM) {
      return NextResponse.json(
        { error: `gridRows must be an integer between 1 and ${MAX_GRID_DIM}` },
        { status: 400 },
      );
    }
    if (!Number.isInteger(gridCols) || gridCols < 1 || gridCols > MAX_GRID_DIM) {
      return NextResponse.json(
        { error: `gridCols must be an integer between 1 and ${MAX_GRID_DIM}` },
        { status: 400 },
      );
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    if (!VISION_ALLOWED.has(modelId)) {
      return NextResponse.json(
        {
          error: `Model "${model.name}" cannot read the reference image. Pick a Claude 4.x, GPT-4o, Gemini 2.x, or any Kie Claude/Gemini variant.`,
        },
        { status: 400 },
      );
    }

    const totalCards = gridRows * gridCols;
    const prefilledLabels = Array.isArray(body.prefilledLabels)
      ? body.prefilledLabels.map((s) => String(s || '').trim()).filter((s) => s.length > 0)
      : undefined;
    if (mode === 'pre-fill') {
      if (!prefilledLabels || prefilledLabels.length !== totalCards) {
        return NextResponse.json(
          {
            error: `Pre-fill mode needs exactly ${totalCards} labels (one per card); received ${prefilledLabels?.length ?? 0}.`,
          },
          { status: 400 },
        );
      }
    }

    // Reference image is required in Phase 1 (curated default PNG lands in
    // Phase 2). Fetch it here and pass the bytes to generateText.
    const referenceImageUrl = (body.referenceImageUrl || '').trim();
    if (!referenceImageUrl) {
      return NextResponse.json(
        {
          error: 'A reference image is required for this format. Upload one or paste a public HTTPS URL.',
        },
        { status: 400 },
      );
    }

    logger.info('[thumb-format-grid cards] start', {
      modelId,
      niche,
      gridRows,
      gridCols,
      mode,
      has_user_reference: true,
      prefilled_count: prefilledLabels?.length ?? 0,
    });

    // Fetch + base64 the reference. Mirrors the multimodal flow shipped on
    // 2026-05-18 (assertSafePublicUrl + plain fetch — the pinned-dispatcher
    // variant trips R2 on Vercel).
    const fetchStart = Date.now();
    let imgRes: Response;
    let rawHostForError = '';
    try {
      try {
        rawHostForError = new URL(referenceImageUrl).hostname;
      } catch {
        /* fall through */
      }
      const safeUrl = assertSafePublicUrl(referenceImageUrl, { allowedProtocols: ['https:'] });
      imgRes = await fetch(safeUrl);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('[thumb-format-grid cards] reference rejected', { reason, host: rawHostForError });
      return NextResponse.json(
        { error: `Reference image URL was rejected (${rawHostForError || 'unknown host'}): ${reason}` },
        { status: 400 },
      );
    }
    if (!imgRes.ok) {
      return NextResponse.json(
        { error: `Failed to fetch reference image (HTTP ${imgRes.status}).` },
        { status: 502 },
      );
    }
    const declaredLen = Number.parseInt(imgRes.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_REFERENCE_BYTES) {
      return NextResponse.json({ error: 'Reference image exceeds 8 MB cap' }, { status: 413 });
    }
    const arrayBuf = await imgRes.arrayBuffer();
    if (arrayBuf.byteLength > MAX_REFERENCE_BYTES) {
      return NextResponse.json({ error: 'Reference image exceeds 8 MB cap' }, { status: 413 });
    }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const mimeType = contentType.includes('png')
      ? 'image/png'
      : contentType.includes('webp')
        ? 'image/webp'
        : contentType.includes('gif')
          ? 'image/gif'
          : 'image/jpeg';
    const base64 = Buffer.from(arrayBuf).toString('base64');
    logger.info('[thumb-format-grid cards] reference fetch', {
      host: rawHostForError,
      bytes: arrayBuf.byteLength,
      mime: mimeType,
      duration_ms: Date.now() - fetchStart,
    });

    const promptInput: LlmPromptInput = {
      title,
      niche,
      script: body.script,
      description: body.description,
      gridRows,
      gridCols,
      prefilledLabels: mode === 'pre-fill' ? prefilledLabels : undefined,
    };
    const { system, user } = topicCardGridLlmPrompt(promptInput);

    // One generation + one retry on validation failure. The retry tightens
    // temperature and quotes the specific reason so the LLM can fix the
    // exact card that failed.
    const callLlm = async (userPrompt: string, temperature: number) =>
      generateText({
        modelId,
        prompt: userPrompt,
        systemPrompt: system,
        maxTokens: 4000,
        temperature,
        image: { base64, mimeType },
        spend: await makeSpendContext('thumbnail_format_topic_card_grid_cards', {
          metadata: { niche, gridRows, gridCols, mode },
        }),
      });

    let raw = await callLlm(user, 0.7);
    let parsed: CardListResult | null = null;
    let validation = validateCardList([], totalCards);
    let retriesUsed = 0;
    try {
      const parsedJson = parseLlmJson(raw);
      parsed = parseCardListResult(parsedJson);
      validation = validateCardList(parsed.cards, totalCards);
    } catch (err) {
      validation = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    if (!validation.ok) {
      retriesUsed = 1;
      logger.warn('[thumb-format-grid cards] validation failed', {
        reason: validation.reason,
        offending_card_index: 'offending_card_index' in validation ? validation.offending_card_index : undefined,
        retries_so_far: 0,
      });
      const retryPrompt = `${user}\n\nThe previous attempt was rejected for this reason: ${validation.reason} Return EXACTLY ${totalCards} cards. Fix the offending entry by replacing the icon_concept with a single bold central icon/symbol on a dark background. No text, no scenes, no people, no UI.`;
      raw = await callLlm(retryPrompt, 0.5);
      try {
        const parsedJson = parseLlmJson(raw);
        parsed = parseCardListResult(parsedJson);
        validation = validateCardList(parsed.cards, totalCards);
      } catch (err) {
        validation = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    if (!validation.ok || !parsed) {
      logger.warn('[thumb-format-grid cards] validation failed', {
        reason: validation.ok ? 'parsed is null' : validation.reason,
        offending_card_index:
          !validation.ok && 'offending_card_index' in validation ? validation.offending_card_index : undefined,
        retries_so_far: retriesUsed,
      });
      return NextResponse.json(
        {
          error: validation.ok
            ? 'Card list could not be parsed from the LLM response. Try again or pick a different model.'
            : `Card list validation failed after a retry: ${validation.reason}`,
        },
        { status: 502 },
      );
    }

    logger.info('[thumb-format-grid cards] done', {
      duration_ms: Date.now() - startedAt,
      cards_count: parsed.cards.length,
      retries_used: retriesUsed,
    });

    return NextResponse.json({
      result: parsed,
      retriesUsed,
    });
  } catch (err) {
    logger.error('[thumb-format-grid cards] error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Card list generation failed' },
      { status: 500 },
    );
  }
}
